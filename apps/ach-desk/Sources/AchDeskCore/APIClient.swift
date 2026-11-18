// HTTP client for the ach Web API (route list: WEB_API_PREFIX comment in src/desks/types.ts).
// Token: `ach web` always has one (Settings, else <stateDir>/web/token, AppSettings.effectiveToken); routes take `?token=` or Bearer
// (src/web/auth.ts requestHasToken), and every request carries BOTH.
import Foundation

public struct ServerConfig: Equatable, Sendable {
    public var host: String
    public var port: Int
    public var token: String?

    public init(host: String = "127.0.0.1", port: Int = 8399, token: String? = nil) {
        self.host = host
        self.port = port
        self.token = (token?.isEmpty ?? true) ? nil : token
    }

    public var baseURL: URL { URL(string: "http://\(host):\(port)")! }
}

public enum APIError: Error, Equatable, CustomStringConvertible {
    case http(status: Int, body: String)
    case transport(String)
    case decoding(String)

    public var description: String {
        switch self {
        case .http(let s, let b): return "HTTP \(s): \(b.prefix(300))"
        case .transport(let m): return "network: \(m)"
        case .decoding(let m): return "decode: \(m)"
        }
    }
}

public final class APIClient: @unchecked Sendable {
    public let config: ServerConfig
    let session: URLSession
    let decoder = JSONDecoder()
    let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    public init(config: ServerConfig, session: URLSession? = nil) {
        self.config = config
        if let session {
            self.session = session
        } else {
            let c = URLSessionConfiguration.ephemeral
            c.timeoutIntervalForRequest = 30
            c.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: c)
        }
    }

    // MARK: request building (internal for tests)

    /// path is relative to /api/desks, e.g. "" or "/send" or "/messages".
    public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var comps = URLComponents(url: config.baseURL, resolvingAgainstBaseURL: false)!
        comps.percentEncodedPath = "/api/desks" + path
        var items = query
        if let t = config.token { items.append(URLQueryItem(name: "token", value: t)) }
        comps.queryItems = items.isEmpty ? nil : items
        return comps.url!
    }

    public func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, accept: String = "application/json") -> URLRequest {
        var r = URLRequest(url: url(path, query: query))
        r.httpMethod = method
        r.setValue(accept, forHTTPHeaderField: "Accept")
        if let t = config.token { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    /// Percent-encode one path segment (desk names are [A-Z0-9_-], decision ids "D1", but be safe).
    static func seg(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    func send<T: Decodable>(_ r: URLRequest, as: T.Type) async throws -> T {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: r)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw APIError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(T.self): \(error)")
        }
    }

    func post<B: Encodable, T: Decodable>(_ path: String, _ body: B, as t: T.Type) async throws -> T {
        try await send(request("POST", path, body: try encoder.encode(body)), as: t)
    }

    struct Empty: Encodable {}
    struct Ignored: Decodable {}

    // MARK: routes

    public func roster() async throws -> RosterView {
        try await send(request("GET", ""), as: RosterView.self)
    }

    public func messages(since: Double? = nil) async throws -> [DeskMessage] {
        let q = since.map { [URLQueryItem(name: "since", value: String(Int64($0)))] } ?? []
        return try await send(request("GET", "/messages", query: q), as: MessagesResponse.self).messages
    }

    public func decisions() async throws -> [Decision] {
        try await send(request("GET", "/decisions"), as: DecisionsResponse.self).decisions
    }

    @discardableResult
    public func answerDecision(id: String, text: String) async throws -> Decision {
        try await post("/decisions/\(Self.seg(id))/answer", AnswerBody(text: text), as: Decision.self)
    }

    @discardableResult
    public func sendMessage(to: String, text: String) async throws -> DeskMessage {
        try await post("/send", SendBody(to: to, text: text), as: DeskMessage.self)
    }

    @discardableResult
    public func up(layoutFile: String? = nil) async throws -> RosterView {
        try await post("/up", UpBody(layoutFile: layoutFile), as: RosterView.self)
    }

    @discardableResult
    public func down() async throws -> [String] {
        try await post("/down", Empty(), as: DownResponse.self).stopped
    }

    public func newLane(_ body: NewLaneBody) async throws -> LaneCreateResult {
        try await post("/lanes", body, as: LaneCreateResult.self)
    }

    public func stopLane(name: String) async throws {
        _ = try await post("/lanes/\(Self.seg(name))/stop", Empty(), as: Ignored.self)
    }

    @discardableResult
    public func approvePending(id: String) async throws -> RosterEntry {
        try await post("/pending/\(Self.seg(id))/approve", Empty(), as: RosterEntry.self)
    }

    @discardableResult
    public func rejectPending(id: String, reason: String? = nil) async throws -> PendingLane {
        try await post("/pending/\(Self.seg(id))/reject", RejectBody(reason: reason), as: PendingLane.self)
    }

    @discardableResult
    public func setEngine(desk: String, agent: String, model: String?) async throws -> RosterEntry {
        try await post("/\(Self.seg(desk))/engine", EngineBody(agent: agent, model: model), as: RosterEntry.self)
    }

    public func events(desk: String, since: Int? = nil) async throws -> [HostEvent] {
        let q = since.map { [URLQueryItem(name: "since", value: String($0))] } ?? []
        return try await send(request("GET", "/\(Self.seg(desk))/events", query: q), as: EventsResponse.self).events
    }

    public func costs() async throws -> [DeskCostRow] {
        try await send(request("GET", "/costs"), as: CostsResponse.self).rows
    }

    public func engines() async throws -> [EngineInfo] {
        try await send(request("GET", "/engines"), as: EnginesResponse.self).engines
    }

    public func mcps() async throws -> [String] {
        try await send(request("GET", "/mcps"), as: McpsResponse.self).names
    }

    /// The SSE request (GET /api/desks/stream). No idle timeout: the stream may be quiet for a long time.
    public func streamRequest() -> URLRequest {
        var r = request("GET", "/stream", accept: "text/event-stream")
        r.timeoutInterval = 24 * 3600
        r.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        return r
    }
}
