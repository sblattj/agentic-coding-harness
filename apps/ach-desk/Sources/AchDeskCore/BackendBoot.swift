// Launch-time decision: reuse a serving `ach web`, start one as a child, or report why not.
import Foundation

public enum BootOutcome: Equatable, Sendable {
    case reused(RosterView)
    case started(location: AchLocation, view: RosterView)
    case failed(String)

    public var note: String {
        switch self {
        case .reused: return "Using the ach web already serving on this port."
        case .started(let loc, _): return "Started ach web from \(loc.path) (\(loc.label))."
        case .failed(let m): return m
        }
    }
}

public enum BackendBoot {
    public static func ensure(
        settings: AppSettings,
        launcher: BackendLauncher,
        process: BackendProcess,
        bundledAchPath: String?,
        waitSeconds: TimeInterval = 30
    ) async -> BootOutcome {
        let client = APIClient(config: settings.serverConfig)
        switch await BackendLauncher.probe(client) {
        case .serving(let v):
            return .reused(v)
        case .occupied(let status, let detail):
            let hint = status == 401 ? " The token in Settings does not match the server's." : status == 404 ? " That ach web has no /api/desks (older ach?)." : ""
            if status == 0 { return .failed("Port \(settings.port) is open but did not answer in time (\(detail)). Not starting a second ach web; retry in a moment.") }
            return .failed("Port \(settings.port) answers HTTP \(status) but is not the ach desks API.\(hint) \(detail)")
        case .notRunning:
            break
        }
        guard settings.autoStartBackend else {
            return .failed("No ach web on port \(settings.port) and auto-start is off. Start `ach web --port \(settings.port)` or enable auto-start in Settings.")
        }
        guard let loc = launcher.resolveAch(settingsPath: settings.achPath, bundledPath: bundledAchPath) else {
            return .failed("Could not find ach: set its path in Settings, install it on your login-shell PATH, or bundle it (scripts/bundle.sh --with-ach).")
        }
        let env = BackendLauncher.childEnvironment(
            base: ProcessInfo.processInfo.environment,
            path: launcher.loginShellPATH(),
            token: settings.token,
            stateDir: settings.stateDir
        )
        do {
            try process.start(achPath: loc.path, port: settings.port, environment: env)
        } catch {
            return .failed("Could not start \(loc.path): \(error.localizedDescription)")
        }
        let deadline = Date().addingTimeInterval(waitSeconds)
        while Date() < deadline {
            if !process.isRunning {
                return .failed("ach web exited during startup; see \(process.logURL.path)")
            }
            if case .serving(let v) = await BackendLauncher.probe(client) { return .started(location: loc, view: v) }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        process.stop() // do not leave a half-booted child running (a retry would orphan it)
        return .failed("ach web did not answer /api/desks within \(Int(waitSeconds)) s; see \(process.logURL.path)")
    }
}
