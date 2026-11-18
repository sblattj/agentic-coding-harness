// Finds ach, probes `ach web`, and starts it as a terminal-less child when nothing serves.
// Order (README "How it finds ach"): Settings path -> `command -v ach` in a login zsh ->
// <App>.app/Contents/Resources/ach. The child gets the login-shell PATH so ach can find the
// agent CLIs (opencode, claude, ...) that a Finder-launched app's minimal PATH would miss.
import Foundation

public enum AchLocation: Equatable, Sendable {
    case settings(String)
    case loginShell(String)
    case bundled(String)

    public var path: String {
        switch self {
        case .settings(let p), .loginShell(let p), .bundled(let p): return p
        }
    }

    public var label: String {
        switch self {
        case .settings: return "Settings"
        case .loginShell: return "login-shell PATH"
        case .bundled: return "bundled in the app"
        }
    }
}

public enum ProbeResult: Equatable, Sendable {
    /// 200 with a RosterView: an `ach web` with the desks API is already serving; reuse it.
    case serving(RosterView)
    /// Connection refused / nothing listening: start one.
    case notRunning
    /// Something answered but not with a RosterView (401, 404, other app): report, do not spawn.
    case occupied(status: Int, detail: String)
}

public struct BackendLauncher: Sendable {
    public typealias Exec = @Sendable (_ launchPath: String, _ args: [String]) -> String?
    public var isExecutable: @Sendable (String) -> Bool
    public var runCapture: Exec

    public init(
        isExecutable: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        runCapture: @escaping Exec = { BackendLauncher.capture($0, $1) }
    ) {
        self.isExecutable = isExecutable
        self.runCapture = runCapture
    }

    /// Pick the last absolute, executable path from `command -v` output (profiles may print noise first;
    /// an alias or function prints a non-path and is skipped).
    public func parseCommandV(_ output: String) -> String? {
        output
            .split(whereSeparator: { $0 == "\n" || $0 == "\r" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .reversed()
            .first { $0.hasPrefix("/") && isExecutable($0) }
    }

    public func resolveAch(settingsPath: String?, bundledPath: String?) -> AchLocation? {
        if let p = settingsPath?.trimmingCharacters(in: .whitespaces), !p.isEmpty {
            let expanded = (p as NSString).expandingTildeInPath
            if isExecutable(expanded) { return .settings(expanded) }
        }
        if let out = runCapture("/bin/zsh", ["-lc", "command -v ach"]), let p = parseCommandV(out) {
            return .loginShell(p)
        }
        if let b = bundledPath, isExecutable(b) { return .bundled(b) }
        return nil
    }

    /// PATH as a login zsh sees it (falls back to the current process PATH plus Homebrew/bun dirs).
    public func loginShellPATH() -> String {
        if let out = runCapture("/bin/zsh", ["-lc", "printf '%s' \"$PATH\""]) {
            let last = out.split(separator: "\n").last.map(String.init) ?? ""
            if last.contains("/") { return last }
        }
        let home = NSHomeDirectory()
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.bun/bin", "\(home)/.local/bin"]
        return ([ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"] + extra).joined(separator: ":")
    }

    /// argv for the child (flag names from src/cli/web.ts: --port, --no-open; token and state dir go by env).
    public static func webArguments(port: Int) -> [String] {
        ["web", "--port", String(port), "--no-open"]
    }

    /// Child environment: inherit, set PATH, token (AGENTIC_CODING_HARNESS_HTTP_TOKEN) and state dir
    /// (AGENTIC_CODING_HARNESS_STATE_DIR). An empty token removes an inherited one so the child
    /// falls back to <stateDir>/web/token, which the app reads too (AppSettings.effectiveToken).
    /// The token goes by env, not --token, so it never shows in `ps`.
    public static func childEnvironment(base: [String: String], path: String, token: String?, stateDir: String?) -> [String: String] {
        var env = base
        env["PATH"] = path
        if let t = token, !t.isEmpty { env["AGENTIC_CODING_HARNESS_HTTP_TOKEN"] = t } else { env.removeValue(forKey: "AGENTIC_CODING_HARNESS_HTTP_TOKEN") }
        if let d = stateDir, !d.isEmpty { env["AGENTIC_CODING_HARNESS_STATE_DIR"] = (d as NSString).expandingTildeInPath }
        return env
    }

    public static func probe(_ client: APIClient) async -> ProbeResult {
        var r: URLRequest
        do { r = try client.request("GET", "") } catch { return .occupied(status: 0, detail: "\(error)") }
        r.timeoutInterval = 3
        do {
            let (data, resp) = try await client.session.data(for: r)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200, let view = try? JSONDecoder().decode(RosterView.self, from: data) {
                return .serving(view)
            }
            return .occupied(status: status, detail: String(decoding: data.prefix(200), as: UTF8.self))
        } catch let e as URLError where [.timedOut].contains(e.code) {
            // Something may be listening but slow (a server mid-boot or wedged): not provably free, so never spawn.
            return .occupied(status: 0, detail: "no answer within \(Int(r.timeoutInterval)) s (timed out)")
        } catch {
            // Connection refused, host unreachable, etc.: nothing is listening.
            return .notRunning
        }
    }

    /// Runs a command and returns its stdout, or nil on failure or when it outlives `timeout` seconds
    /// (a slow login shell must not block boot forever; callers fall back).
    public static func capture(_ launchPath: String, _ args: [String], _ timeout: TimeInterval = 10) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let box = CaptureBox()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            box.data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            return nil
        }
        guard p.terminationStatus == 0 else { return nil }
        return String(decoding: box.data, as: UTF8.self)
    }

    private final class CaptureBox: @unchecked Sendable { var data = Data() }
}

/// Owns the `ach web` child the app started (if any). Stops it on quit; never kills a server it did not start.
public final class BackendProcess: @unchecked Sendable {
    public private(set) var process: Process?
    public let logURL: URL

    public init(logURL: URL) { self.logURL = logURL }

    public enum StartError: Error, LocalizedError {
        case alreadyRunning
        public var errorDescription: String? { "An ach web child started by this app is still running." }
    }

    public var isRunning: Bool { process?.isRunning ?? false }

    /// Refuses while a child is still running: overwriting `process` would orphan it past quit.
    public func start(achPath: String, port: Int, environment: [String: String]) throws {
        if isRunning { throw StartError.alreadyRunning }
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let log = try FileHandle(forWritingTo: logURL)
        defer { try? log.close() } // the child keeps its own dup of the fd
        log.seekToEndOfFile()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: achPath)
        p.arguments = BackendLauncher.webArguments(port: port)
        p.environment = environment
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        try p.run()
        process = p
    }

    /// SIGTERM, wait up to `grace` seconds, then SIGKILL.
    public func stop(grace: TimeInterval = 3) {
        guard let p = process, p.isRunning else { process = nil; return }
        p.terminate()
        let deadline = Date().addingTimeInterval(grace)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
        process = nil
    }
}
