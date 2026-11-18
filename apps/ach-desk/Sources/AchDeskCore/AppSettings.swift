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
    /// `ach web --token` value; sent as Bearer + ?token=. Empty = use the token `ach web`
    /// generates into <stateDir>/web/token (see `effectiveToken`).
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

    public var serverConfig: ServerConfig { ServerConfig(port: port, token: effectiveToken()) }

    /// The state dir `ach web` uses, by the CLI's rule (src/core/store.ts stateDir): the Settings
    /// value (passed to the child as AGENTIC_CODING_HARNESS_STATE_DIR), else that env var, else
    /// ~/.agentic-coding-harness.
    public func resolvedStateDir(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String {
        if !stateDir.isEmpty { return (stateDir as NSString).expandingTildeInPath }
        if let d = environment["AGENTIC_CODING_HARNESS_STATE_DIR"], !d.isEmpty { return d }
        return (home as NSString).appendingPathComponent(".agentic-coding-harness")
    }

    /// Path of the token `ach web` generates when it has no --token (src/web/auth.ts webTokenPath).
    public func webTokenPath(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String {
        ((resolvedStateDir(environment: environment, home: home) as NSString).appendingPathComponent("web") as NSString).appendingPathComponent("token")
    }

    /// The token to send: the Settings token when set, else the stored `ach web` token (trimmed,
    /// at least 16 chars like src/web/auth.ts accepts), else nil (no server has made one yet).
    public func effectiveToken(environment: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> String? {
        if !token.isEmpty { return token }
        let path = webTokenPath(environment: environment, home: home)
        guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count >= 16 ? t : nil
    }

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
