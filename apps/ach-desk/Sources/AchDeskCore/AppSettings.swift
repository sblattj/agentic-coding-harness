// Persisted app settings (UserDefaults, one JSON blob under "achDesk.settings").
import Foundation

public struct EngineChoice: Codable, Equatable, Sendable {
    public var agent: String
    public var model: String?
    public init(agent: String, model: String? = nil) { self.agent = agent; self.model = model }
}

public struct AppSettings: Codable, Equatable, Sendable {
    /// Explicit ach binary; empty = look it up (login-shell PATH, then bundled).
    public var achPath: String = ""
    /// `ach web` port (src/cli/web.ts DEFAULT_PORT = 8399).
    public var port: Int = 8399
    /// `ach web --token` value; sent as Bearer + ?token=. Empty = none.
    public var token: String = ""
    /// Passed to the child as AGENTIC_CODING_HARNESS_STATE_DIR. Empty = ach's default (~/.agentic-coding-harness).
    public var stateDir: String = ""
    /// Default engine for new lanes ("" = the server/layout default).
    public var defaultLaneAgent: String = ""
    public var defaultLaneModel: String = ""
    /// Default engine/model per role (applied with POST /:name/engine when changed).
    public var roleEngines: [String: EngineChoice] = [:]
    /// Start the app's own `ach web` when none is serving.
    public var autoStartBackend: Bool = true
    /// Stop the stack (POST /down) when quitting, if the app started `ach web`.
    public var stopStackOnQuit: Bool = false
    /// POST /api/desks/up (the default layout) on launch when the roster has no desks.
    public var startStackOnLaunch: Bool = true

    public init() {}

    public var serverConfig: ServerConfig { ServerConfig(port: port, token: token) }

    static let key = "achDesk.settings"

    public static func load(_ defaults: UserDefaults = .standard) -> AppSettings {
        guard let data = defaults.data(forKey: key), let s = try? JSONDecoder().decode(AppSettings.self, from: data) else { return AppSettings() }
        return s
    }

    public func save(_ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
    }

    // Tolerate settings written by older builds (missing keys -> defaults).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        achPath = try c.decodeIfPresent(String.self, forKey: .achPath) ?? d.achPath
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? d.port
        token = try c.decodeIfPresent(String.self, forKey: .token) ?? d.token
        stateDir = try c.decodeIfPresent(String.self, forKey: .stateDir) ?? d.stateDir
        defaultLaneAgent = try c.decodeIfPresent(String.self, forKey: .defaultLaneAgent) ?? d.defaultLaneAgent
        defaultLaneModel = try c.decodeIfPresent(String.self, forKey: .defaultLaneModel) ?? d.defaultLaneModel
        roleEngines = try c.decodeIfPresent([String: EngineChoice].self, forKey: .roleEngines) ?? d.roleEngines
        autoStartBackend = try c.decodeIfPresent(Bool.self, forKey: .autoStartBackend) ?? d.autoStartBackend
        stopStackOnQuit = try c.decodeIfPresent(Bool.self, forKey: .stopStackOnQuit) ?? d.stopStackOnQuit
        startStackOnLaunch = try c.decodeIfPresent(Bool.self, forKey: .startStackOnLaunch) ?? d.startStackOnLaunch
    }
}
