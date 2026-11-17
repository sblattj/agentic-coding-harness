// Swift mirror of the Web API shapes in src/desks/types.ts (DESKS_API_VERSION "desks-api/1").
// Rules: optional TS fields are optionals; unknown JSON fields are ignored (Decodable default);
// string unions (state, kind, type, ...) stay plain Strings so a new server-side case never
// fails a whole roster decode. Times are epoch milliseconds (JS Date.now()).
import Foundation

public let desksAPIVersion = "desks-api/1"

// MARK: - JSONValue (HostEvent.data and other open records)

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
}

// MARK: - Roster

public struct TerminalRef: Codable, Equatable, Sendable {
    public var kind: String // "tmux" | "ghostty" | "none"
    public var id: String
}

public struct RosterEntry: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var kind: String // "desk" | "lane"
    public var role: String
    public var agent: String
    public var engine: String // "opencode" | "driver"
    public var model: String?
    public var mcps: [String]
    public var port: Int
    public var url: String
    public var pid: Int
    public var runId: String
    public var parentRunId: String?
    public var sessionId: String?
    public var engineUrl: String?
    public var cwd: String
    public var startedAt: Double
    public var goal: String?
    public var launchedBy: String?
    public var feedPid: Int?
    public var terminal: TerminalRef?
    public var budgetUsd: Double?

    public var id: String { name }
    public var isLane: Bool { kind == "lane" }
}

public struct GoalPlan: Codable, Equatable, Sendable {
    public var verified: Int
    public var total: Int
}

public struct GoalStatus: Codable, Equatable, Sendable {
    public var objective: String
    public var state: String // "none" | "active" | "achieved" | "blocked" | "stopped"
    public var source: String // "opencode-plugin" | "ach-loop"
    public var evidence: String?
    public var reason: String?
    public var plan: GoalPlan?
    public var updatedAt: Double
}

/// RosterRow extends RosterEntry in TS; here the entry fields are decoded from the same object.
public struct RosterRow: Decodable, Equatable, Sendable, Identifiable {
    public var entry: RosterEntry
    public var state: String // HostState | "dead"
    public var queueDepth: Int
    public var goalStatus: GoalStatus?
    public var costUsd: Double?
    public var treeCostUsd: Double?

    public var id: String { entry.name }
    public var name: String { entry.name }
    public var isLane: Bool { entry.isLane }
    public var isAlive: Bool { state != "dead" }

    enum CodingKeys: String, CodingKey { case state, queueDepth, goalStatus, costUsd, treeCostUsd }

    public init(entry: RosterEntry, state: String, queueDepth: Int, goalStatus: GoalStatus? = nil, costUsd: Double? = nil, treeCostUsd: Double? = nil) {
        self.entry = entry
        self.state = state
        self.queueDepth = queueDepth
        self.goalStatus = goalStatus
        self.costUsd = costUsd
        self.treeCostUsd = treeCostUsd
    }

    public init(from decoder: Decoder) throws {
        entry = try RosterEntry(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(String.self, forKey: .state)
        queueDepth = try c.decodeIfPresent(Int.self, forKey: .queueDepth) ?? 0
        goalStatus = try c.decodeIfPresent(GoalStatus.self, forKey: .goalStatus)
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd)
        treeCostUsd = try c.decodeIfPresent(Double.self, forKey: .treeCostUsd)
    }
}

public struct RosterView: Decodable, Equatable, Sendable {
    public var version: String
    public var stack: String
    public var portBase: Int
    public var me: String?
    public var rows: [RosterRow]
    public var pendingLanes: [PendingLane]
    public var openDecisions: [Decision]

    public init(version: String = desksAPIVersion, stack: String, portBase: Int, me: String? = nil, rows: [RosterRow], pendingLanes: [PendingLane] = [], openDecisions: [Decision] = []) {
        self.version = version
        self.stack = stack
        self.portBase = portBase
        self.me = me
        self.rows = rows
        self.pendingLanes = pendingLanes
        self.openDecisions = openDecisions
    }

    enum CodingKeys: String, CodingKey { case version, stack, portBase, me, rows, pendingLanes, openDecisions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        stack = try c.decode(String.self, forKey: .stack)
        portBase = try c.decode(Int.self, forKey: .portBase)
        me = try c.decodeIfPresent(String.self, forKey: .me)
        rows = try c.decodeIfPresent([RosterRow].self, forKey: .rows) ?? []
        pendingLanes = try c.decodeIfPresent([PendingLane].self, forKey: .pendingLanes) ?? []
        openDecisions = try c.decodeIfPresent([Decision].self, forKey: .openDecisions) ?? []
    }

    public var desks: [RosterRow] { rows.filter { !$0.isLane } }
    public var lanes: [RosterRow] { rows.filter { $0.isLane } }
}

// MARK: - Messages

public struct DeskMessage: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var from: String
    public var to: String
    public var text: String
    public var at: Double
    public var delivered: String // "now" | "queued"
}

// MARK: - Decisions

public struct DecisionOption: Codable, Equatable, Sendable {
    public var label: String
    public var recommended: Bool?
    public var reason: String?

    public init(label: String, recommended: Bool? = nil, reason: String? = nil) {
        self.label = label
        self.recommended = recommended
        self.reason = reason
    }
}

public struct DecisionAnswer: Codable, Equatable, Sendable {
    public var text: String
    public var by: String
    public var at: Double
}

public struct Decision: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var question: String
    public var options: [DecisionOption]
    public var askedBy: String
    public var openedBy: String
    public var openedAt: Double
    public var state: String // "open" | "answered" | "closed"
    public var answer: DecisionAnswer?

    public init(id: String, question: String, options: [DecisionOption], askedBy: String, openedBy: String = "DECISIONS", openedAt: Double, state: String = "open", answer: DecisionAnswer? = nil) {
        self.id = id
        self.question = question
        self.options = options
        self.askedBy = askedBy
        self.openedBy = openedBy
        self.openedAt = openedAt
        self.state = state
        self.answer = answer
    }

    public var isOpen: Bool { state == "open" }

    /// Recommended options first (stable within each group), as the cards and banners show them.
    public var orderedOptions: [DecisionOption] {
        options.filter { $0.recommended == true } + options.filter { $0.recommended != true }
    }
}

// MARK: - Pending lanes

public struct LaneRequest: Codable, Equatable, Sendable {
    public var name: String
    public var goal: String
    public var mcps: [String]?
    public var cwd: String?
    public var agent: String?
    public var model: String?
    public var budgetUsd: Double?
    public var launchedBy: String
}

public struct PendingLane: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var request: LaneRequest
    public var requestedAt: Double
    public var state: String // "pending" | "approved" | "rejected"
    public var decidedBy: String?
    public var decidedAt: Double?
    public var reason: String?
}

// MARK: - Host events

public struct HostEvent: Codable, Equatable, Sendable, Identifiable {
    public var seq: Int
    public var at: Double
    public var runId: String
    public var name: String
    public var type: String // HostEventType
    public var data: [String: JSONValue]

    public init(seq: Int, at: Double, runId: String, name: String, type: String, data: [String: JSONValue] = [:]) {
        self.seq = seq
        self.at = at
        self.runId = runId
        self.name = name
        self.type = type
        self.data = data
    }

    enum CodingKeys: String, CodingKey { case seq, at, runId, name, type, data }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        at = try c.decode(Double.self, forKey: .at)
        runId = try c.decode(String.self, forKey: .runId)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decode(String.self, forKey: .type)
        data = try c.decodeIfPresent([String: JSONValue].self, forKey: .data) ?? [:]
    }

    public var id: String { "\(runId)#\(seq)" }

    /// One display line for the chat timeline.
    public var displayText: String? {
        switch type {
        case "text": return data["text"]?.stringValue
        case "tool":
            let tool = data["tool"]?.stringValue ?? "tool"
            if let s = data["summary"]?.stringValue, !s.isEmpty { return "\(tool): \(s)" }
            return tool
        case "status": return data["state"]?.stringValue.map { "status: \($0)" }
        case "feed": return data["note"]?.stringValue.map { "feed: \($0)" }
        case "error": return data["error"]?.stringValue.map { "error: \($0)" }
        case "goal":
            if let g = data["goal"], let st = g["state"]?.stringValue { return "goal: \(st)" }
            return nil
        case "turn_start", "turn_end", "usage", "message_in", "message_out": return nil
        default: return nil
        }
    }
}

// MARK: - Costs, engines, MCPs

public struct DeskCostRow: Codable, Equatable, Sendable {
    public var name: String
    public var kind: String
    public var runId: String
    public var parentRunId: String?
    public var costUsd: Double?
    public var inputTokens: Int
    public var outputTokens: Int
    public var lanes: [DeskCostRow]

    enum CodingKeys: String, CodingKey { case name, kind, runId, parentRunId, costUsd, inputTokens, outputTokens, lanes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decode(String.self, forKey: .kind)
        runId = try c.decode(String.self, forKey: .runId)
        parentRunId = try c.decodeIfPresent(String.self, forKey: .parentRunId)
        costUsd = try c.decodeIfPresent(Double.self, forKey: .costUsd)
        inputTokens = try c.decodeIfPresent(Int.self, forKey: .inputTokens) ?? 0
        outputTokens = try c.decodeIfPresent(Int.self, forKey: .outputTokens) ?? 0
        lanes = try c.decodeIfPresent([DeskCostRow].self, forKey: .lanes) ?? []
    }
}

public struct EngineInfo: Codable, Equatable, Sendable, Identifiable {
    public var agent: String
    public var found: Bool
    public var path: String?
    public var auth: String?
    public var id: String { agent }
}

// MARK: - Response envelopes

public struct MessagesResponse: Decodable, Sendable { public var messages: [DeskMessage] }
public struct DecisionsResponse: Decodable, Sendable { public var decisions: [Decision] }
public struct EventsResponse: Decodable, Sendable { public var events: [HostEvent] }
public struct CostsResponse: Decodable, Sendable { public var rows: [DeskCostRow] }
public struct EnginesResponse: Decodable, Sendable { public var engines: [EngineInfo] }
public struct McpsResponse: Decodable, Sendable { public var names: [String] }
public struct DownResponse: Decodable, Sendable { public var stopped: [String] }

/// POST /api/desks/lanes -> RosterEntry | {pending: PendingLane}
public enum LaneCreateResult: Decodable, Equatable, Sendable {
    case started(RosterEntry)
    case pending(PendingLane)

    enum CodingKeys: String, CodingKey { case pending }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let p = try c.decodeIfPresent(PendingLane.self, forKey: .pending) {
            self = .pending(p)
        } else {
            self = .started(try RosterEntry(from: decoder))
        }
    }
}

// MARK: - Stream items (GET /api/desks/stream)

public enum StreamItem: Equatable, Sendable {
    case message(DeskMessage)
    case roster(RosterView)
    case event(HostEvent)
    case decision(Decision)
    /// A kind this build does not know; ignored by the store.
    case unknown(String)

    struct Probe: Decodable { var kind: String }
    struct MessageItem: Decodable { var message: DeskMessage }
    struct RosterItem: Decodable { var view: RosterView }
    struct EventItem: Decodable { var event: HostEvent }
    struct DecisionItem: Decodable { var decision: Decision }

    /// Decode one SSE `data:` payload.
    public static func decode(_ data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> StreamItem {
        let kind = try decoder.decode(Probe.self, from: data).kind
        switch kind {
        case "message": return .message(try decoder.decode(MessageItem.self, from: data).message)
        case "roster": return .roster(try decoder.decode(RosterItem.self, from: data).view)
        case "event": return .event(try decoder.decode(EventItem.self, from: data).event)
        case "decision": return .decision(try decoder.decode(DecisionItem.self, from: data).decision)
        default: return .unknown(kind)
        }
    }
}

// MARK: - Request bodies (nil optionals are omitted by the synthesized encoder)

public struct SendBody: Encodable, Equatable, Sendable {
    public var to: String
    public var text: String
    public init(to: String, text: String) { self.to = to; self.text = text }
}

public struct AnswerBody: Encodable, Equatable, Sendable {
    public var text: String
    public init(text: String) { self.text = text }
}

public struct UpBody: Encodable, Equatable, Sendable {
    public var layoutFile: String?
    public init(layoutFile: String? = nil) { self.layoutFile = layoutFile }
}

public struct RejectBody: Encodable, Equatable, Sendable {
    public var reason: String?
    public init(reason: String? = nil) { self.reason = reason }
}

public struct EngineBody: Encodable, Equatable, Sendable {
    public var agent: String
    public var model: String?
    public init(agent: String, model: String? = nil) { self.agent = agent; self.model = model }
}

public struct NewLaneBody: Encodable, Equatable, Sendable {
    public var name: String
    public var goal: String
    public var mcps: [String]?
    public var cwd: String?
    public var agent: String?
    public var model: String?
    public var budgetUsd: Double?

    public init(name: String, goal: String, mcps: [String]? = nil, cwd: String? = nil, agent: String? = nil, model: String? = nil, budgetUsd: Double? = nil) {
        self.name = name
        self.goal = goal
        self.mcps = mcps
        self.cwd = cwd
        self.agent = agent
        self.model = model
        self.budgetUsd = budgetUsd
    }

    /// Lane name rule from src/desks/roster.ts validName(lane): /^[a-z0-9][a-z0-9_-]{0,47}$/i (case-insensitive,
    /// may start with a digit, up to 48 chars). "human" is reserved (the sender id for the user), any case.
    public static func isValidName(_ s: String) -> Bool {
        guard s.range(of: "^[a-z0-9][a-z0-9_-]{0,47}$", options: [.regularExpression, .caseInsensitive]) != nil else { return false }
        // NSRegularExpression's $ also matches before a trailing newline; JS /$/ does not.
        if s.hasSuffix("\n") { return false }
        return s.lowercased() != "human"
    }
}
