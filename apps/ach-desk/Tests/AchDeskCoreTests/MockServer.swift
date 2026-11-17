// Minimal HTTP/1.1 server on 127.0.0.1:<ephemeral> (Network.framework) for client tests.
// Records every request; answers JSON or a scripted SSE stream.
import Foundation
import Network

struct RecordedRequest: Sendable {
    var method: String
    var path: String
    var query: [String: String]
    var headers: [String: String] // lower-cased names
    var body: Data

    var jsonBody: NSDictionary? { (try? JSONSerialization.jsonObject(with: body)) as? NSDictionary }
}

enum MockResponse: Sendable {
    case json(Int, String)
    /// SSE: send each chunk after its delay (seconds); close the connection afterwards when `close`.
    case sse(chunks: [(TimeInterval, String)], close: Bool)
}

final class MockServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "mock-server")
    private let lock = NSLock()
    private var _requests: [RecordedRequest] = []
    private var connections: [NWConnection] = []
    let handler: @Sendable (RecordedRequest, Int) -> MockResponse
    private(set) var port: Int = 0

    /// handler(request, indexOfThisRequestForThatPath)
    init(handler: @escaping @Sendable (RecordedRequest, Int) -> MockResponse) throws {
        self.handler = handler
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
    }

    var requests: [RecordedRequest] { lock.withLock { _requests } }

    func start() async throws {
        let ready = AsyncReady()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.resume(nil)
            case .failed(let e): ready.resume(e)
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.start(queue: queue)
        try await ready.wait()
        port = Int(listener.port?.rawValue ?? 0)
    }

    func stop() {
        listener.cancel()
        lock.withLock {
            for c in connections { c.cancel() }
            connections.removeAll()
        }
    }

    private func accept(_ conn: NWConnection) {
        lock.withLock { connections.append(conn) }
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let req = Self.parse(buf) {
                self.respond(conn, req)
                return
            }
            if isComplete || error != nil { conn.cancel(); return }
            self.receive(conn, buffer: buf)
        }
    }

    static func parse(_ buf: Data) -> RecordedRequest? {
        guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buf[..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ")
        guard start.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for l in lines {
            guard let c = l.firstIndex(of: ":") else { continue }
            headers[l[..<c].lowercased()] = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        let len = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = headerEnd.upperBound
        guard buf.count - bodyStart >= len else { return nil }
        let body = buf.subdata(in: bodyStart..<(bodyStart + len))
        let target = String(start[1])
        let comps = URLComponents(string: "http://x" + target)
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return RecordedRequest(method: String(start[0]), path: comps?.percentEncodedPath ?? target, query: query, headers: headers, body: body)
    }

    private func respond(_ conn: NWConnection, _ req: RecordedRequest) {
        let index: Int = lock.withLock {
            let n = _requests.filter { $0.path == req.path }.count
            _requests.append(req)
            return n
        }
        switch handler(req, index) {
        case .json(let status, let body):
            let b = Data(body.utf8)
            let head = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(b.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(head.utf8) + b, completion: .contentProcessed { _ in conn.cancel() })
        case .sse(let chunks, let close):
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
            conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
            var t: TimeInterval = 0
            for (delay, text) in chunks {
                t += delay
                queue.asyncAfter(deadline: .now() + t) {
                    conn.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
                }
            }
            if close {
                queue.asyncAfter(deadline: .now() + t + 0.05) { conn.cancel() }
            }
        }
    }
}

/// One-shot continuation bridge that tolerates late/duplicate resumes.
final class AsyncReady: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Void, Error>?
    private var result: Error??

    func resume(_ error: Error?) {
        lock.lock()
        if result != nil { lock.unlock(); return }
        result = .some(error)
        let c = cont
        cont = nil
        lock.unlock()
        if let c { if let error { c.resume(throwing: error) } else { c.resume() } }
    }

    func wait() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            lock.lock()
            if let r = result {
                lock.unlock()
                if let e = r { c.resume(throwing: e) } else { c.resume() }
                return
            }
            cont = c
            lock.unlock()
        }
    }
}

/// Poll `cond` until true or timeout.
func eventually(timeout: TimeInterval = 5, _ cond: () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if cond() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return cond()
}
