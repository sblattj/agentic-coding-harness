// Incremental Server-Sent Events parser (WHATWG "event stream interpretation") plus the
// reconnect backoff and the URLSession stream client used for GET /api/desks/stream.
// Fed raw bytes, not AsyncBytes.lines: the blank line that ends an event must be seen.
import Foundation

public struct SSEEvent: Equatable, Sendable {
    public var event: String // "message" when no `event:` field
    public var data: String
    public var id: String?
}

public struct SSEParser: Sendable {
    private var buffer = Data()
    private var dataLines: [String] = []
    private var eventName = ""
    private var pendingID: String?
    private var sawCR = false
    /// True until the first line of this connection is processed (a leading U+FEFF BOM is stripped there).
    private var atStreamStart = true
    /// ID of the last DISPATCHED event (sent back as Last-Event-ID on reconnect).
    public private(set) var lastEventID: String?
    /// Server-requested reconnect delay (`retry:` field), in milliseconds.
    public private(set) var retryMs: Int?

    public init() {}

    /// Drop any half-received event (call on disconnect); lastEventID/retry survive.
    public mutating func reset() {
        buffer.removeAll()
        dataLines.removeAll()
        eventName = ""
        pendingID = nil
        sawCR = false
        atStreamStart = true // the next connection is a new stream, which may start with its own BOM
    }

    public mutating func feed(_ chunk: String) -> [SSEEvent] { feed(Data(chunk.utf8)) }

    public mutating func feed(_ chunk: Data) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for byte in chunk {
            if sawCR {
                sawCR = false
                if byte == 0x0A { continue } // CRLF: the CR already ended the line
            }
            if byte == 0x0D { // CR
                sawCR = true
                processLine(&out)
            } else if byte == 0x0A { // LF
                processLine(&out)
            } else {
                buffer.append(byte)
            }
        }
        return out
    }

    private mutating func processLine(_ out: inout [SSEEvent]) {
        // Spec: one leading U+FEFF (EF BB BF) at the start of the stream is ignored.
        if atStreamStart {
            atStreamStart = false
            if buffer.starts(with: [0xEF, 0xBB, 0xBF]) { buffer.removeFirst(3) }
        }
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        if line.isEmpty {
            dispatch(&out)
            return
        }
        if line.hasPrefix(":") { return } // comment / keepalive
        var field = line
        var value = ""
        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        }
        switch field {
        case "data": dataLines.append(value)
        case "event": eventName = value
        case "id": if !value.contains("\0") { pendingID = value } // committed to lastEventID on dispatch only
        case "retry": // spec: ASCII digits only ("+5", "-5", "1e3" are ignored)
            if !value.isEmpty, value.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let n = Int(value) { retryMs = n }
        default: break
        }
    }

    private mutating func dispatch(_ out: inout [SSEEvent]) {
        defer { dataLines.removeAll(); eventName = ""; pendingID = nil }
        if let id = pendingID { lastEventID = id } // spec: set at dispatch, even for an event with empty data
        guard !dataLines.isEmpty else { return }
        out.append(SSEEvent(event: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"), id: pendingID ?? lastEventID))
    }
}

/// Exponential reconnect backoff: base * 2^(failures-1), capped; reset on a successful open.
public struct Backoff: Equatable, Sendable {
    public var base: TimeInterval
    public var cap: TimeInterval
    public private(set) var failures = 0

    public init(base: TimeInterval = 0.5, cap: TimeInterval = 30) {
        self.base = base
        self.cap = cap
    }

    /// Record a failure and return the delay before the next attempt.
    public mutating func nextDelay() -> TimeInterval {
        failures += 1
        return min(cap, base * pow(2, Double(failures - 1)))
    }

    public mutating func reset() { failures = 0 }

    /// After this many consecutive failures the store polls every 2 s until SSE comes back.
    public static let pollingThreshold = 2
    public var shouldPoll: Bool { failures >= Self.pollingThreshold }
}

public enum StreamStatus: Equatable, Sendable {
    case connecting
    case connected
    case disconnected(retryIn: TimeInterval, failures: Int)
    case stopped
}

/// Long-lived SSE connection with reconnect + backoff. Callbacks arrive on the main queue.
public final class SSEStreamClient: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    public var onItem: ((StreamItem) -> Void)?
    public var onStatus: ((StreamStatus) -> Void)?
    public var onDecodeError: ((String) -> Void)?
    /// The request could not be built (bad host); the stream stops instead of retrying.
    public var onRequestError: ((String) -> Void)?

    private let makeRequest: () throws -> URLRequest
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var parser = SSEParser()
    private var backoff: Backoff
    private var stopped = true
    private var generation = 0
    private let callbackQueue: DispatchQueue

    public init(request: @escaping () throws -> URLRequest, backoff: Backoff = Backoff(), callbackQueue: DispatchQueue = .main) {
        self.makeRequest = request
        self.backoff = backoff
        self.callbackQueue = callbackQueue
        super.init()
    }

    public var failures: Int { lock.withLock { backoff.failures } }

    public func start() {
        lock.withLock { stopped = false }
        connect()
    }

    public func stop() {
        lock.withLock {
            stopped = true
            generation += 1
            task?.cancel()
            task = nil
            session?.invalidateAndCancel()
            session = nil
        }
        emit(.stopped)
    }

    private func connect() {
        var buildError: String?
        let (req, gen): (URLRequest?, Int) = lock.withLock {
            guard !stopped else { return (nil, generation) }
            generation += 1
            parser.reset()
            var r: URLRequest
            do { r = try makeRequest() } catch {
                stopped = true
                buildError = "\(error)"
                return (nil, generation)
            }
            if let last = parser.lastEventID { r.setValue(last, forHTTPHeaderField: "Last-Event-ID") }
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = 24 * 3600
            cfg.timeoutIntervalForResource = 7 * 24 * 3600
            session?.invalidateAndCancel()
            let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
            session = s
            let t = s.dataTask(with: r)
            task = t
            t.resume()
            return (r, generation)
        }
        if let msg = buildError {
            let cb = onRequestError
            callbackQueue.async { cb?(msg) }
            emit(.stopped)
            return
        }
        guard req != nil else { return }
        _ = gen
        emit(.connecting)
    }

    private func emit(_ s: StreamStatus) {
        let cb = onStatus
        callbackQueue.async { cb?(s) }
    }

    /// Reconnect delay: the server's last `retry:` wins; exponential backoff is the fallback.
    /// Call with `lock` held. The backoff still counts the failure (drives polling).
    private func nextReconnectDelayLocked() -> TimeInterval {
        let backoffDelay = backoff.nextDelay()
        guard let r = parser.retryMs else { return backoffDelay }
        return Double(r) / 1000
    }

    /// Internal seams for tests.
    func ingestForTesting(_ chunk: String) { lock.withLock { _ = parser.feed(chunk) } }
    func lastEventIDForTesting() -> String? { lock.withLock { parser.lastEventID } }
    func nextReconnectDelayForTesting() -> TimeInterval { lock.withLock { nextReconnectDelayLocked() } }

    private func scheduleReconnect() {
        let (delay, fails): (TimeInterval?, Int) = lock.withLock {
            guard !stopped else { return (nil, 0) }
            task = nil
            return (nextReconnectDelayLocked(), backoff.failures)
        }
        guard let delay else { return }
        emit(.disconnected(retryIn: delay, failures: fails))
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    // MARK: URLSessionDataDelegate

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let ctype = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
        guard status == 200, ctype.lowercased().contains("text/event-stream") else {
            completionHandler(.cancel)
            return
        }
        // A response from a task replaced by a reconnect (or cancelled by stop) is stale: it must not
        // reset the backoff or report .connected for the current stream. Check and reset under one lock.
        let current: Bool = lock.withLock {
            guard self.task === dataTask else { return false }
            backoff.reset()
            return true
        }
        guard current else {
            completionHandler(.cancel)
            return
        }
        emit(.connected)
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let events: [SSEEvent] = lock.withLock {
            guard self.task === dataTask else { return [] }
            return parser.feed(data)
        }
        for e in events {
            do {
                let item = try StreamItem.decode(Data(e.data.utf8))
                let cb = onItem
                callbackQueue.async { cb?(item) }
            } catch {
                let cb = onDecodeError
                let msg = "\(error)"
                callbackQueue.async { cb?(msg) }
            }
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let current: Bool = lock.withLock { self.task === task }
        guard current else { return }
        scheduleReconnect()
    }
}
