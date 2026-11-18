// App-level coordinator: settings, backend boot/teardown, notifications, Dock badge, HUD, hotkey.
import SwiftUI
import AppKit
import AchDeskCore

@MainActor
final class AppModel: ObservableObject {
    static let mainWindowID = "main"

    @Published var settings: AppSettings
    @Published var bootOutcome: BootOutcome?
    @Published var booting = false
    @Published var section: SidebarSection? = .desks
    @Published var focusLane: String?

    let store: DeskStore
    let launcher = BackendLauncher()
    let backend: BackendProcess
    let hud: HUDController
    let notifier: Notifier
    private var hotKey: HotKey?

    init() {
        let s = AppSettings.load()
        settings = s
        store = DeskStore(client: APIClient(config: s.serverConfig))
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/ach Desk/ach-web.log")
        backend = BackendProcess(logURL: logs)
        hud = HUDController(store: store)
        notifier = Notifier()
    }

    var bundledAchPath: String? {
        Bundle.main.resourceURL?.appendingPathComponent("ach").path
    }

    func boot() {
        notifier.onAnswer = { [weak self] id, text in await self?.store.answer(decisionID: id, text: text) }
        notifier.decisionLookup = { [weak self] id in self?.store.decisions.first { $0.id == id } }
        notifier.onLaneAction = { [weak self] action in
            guard let self else { return }
            switch action {
            case .open(let name): self.openMainWindow(); self.section = .lanes; self.focusLane = name
            case .stop(let name): await self.store.stopLane(name)
            }
        }
        notifier.setUp()
        store.onDecisionOpened = { [weak self] d in self?.notifier.postDecision(d) }
        store.onDecisionsChanged = { [weak self] open in
            self?.notifier.registerCategories(open)
            NSApp.dockTile.badgeLabel = open.isEmpty ? nil : String(open.count)
        }
        store.onLaneTransition = { [weak self] name, state in self?.notifier.postLane(name: name, state: state) }
        hotKey = HotKey(keyCode: HotKey.keyT, modifiers: HotKey.controlOptionCommand) { [weak self] in
            self?.hud.toggle()
        }
        connect()
    }

    /// Probe / start `ach web`, then attach the store (SSE + polling) and start the layout if empty.
    func connect() {
        booting = true
        let s = settings
        store.reconfigure(s.serverConfig)
        Task {
            let outcome = await BackendBoot.ensure(settings: s, launcher: launcher, process: backend, bundledAchPath: bundledAchPath)
            bootOutcome = outcome
            // A child started without a Settings token generated <stateDir>/web/token just now.
            store.reconfigure(s.serverConfig)
            store.backendNote = outcome.note
            booting = false
            store.start()
            switch outcome {
            case .reused(let v), .started(_, let v):
                if s.startStackOnLaunch && v.rows.filter({ !$0.isLane }).isEmpty { await store.up() }
            case .failed:
                break
            }
        }
    }

    func applySettings(_ new: AppSettings) {
        let needsReconnect = new.port != settings.port || new.token != settings.token || new.stateDir != settings.stateDir || new.achPath != settings.achPath
        settings = new
        new.save()
        if needsReconnect {
            backend.stop()
            connect()
        }
    }

    func shutdown(_ done: @escaping () -> Void) {
        store.stop()
        hud.close()
        let startedByUs = backend.isRunning
        let stopStack = settings.stopStackOnQuit && startedByUs
        Task {
            if stopStack { await store.down() }
            backend.stop()
            done()
        }
    }

    func openMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        if let w = NSApp.windows.first(where: { $0.identifier?.rawValue == Self.mainWindowID || $0.title == "ach Desk" }) {
            w.makeKeyAndOrderFront(nil)
        } else {
            openWindowAction?(Self.mainWindowID)
        }
    }

    /// Set by a view that has \.openWindow (SwiftUI only exposes it inside views).
    var openWindowAction: ((String) -> Void)?
}

enum SidebarSection: String, CaseIterable, Identifiable, Hashable {
    case desks = "Desks", lanes = "Lanes", decisions = "Decisions", messages = "Messages", settings = "Settings"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .desks: return "rectangle.grid.2x2"
        case .lanes: return "arrow.triangle.branch"
        case .decisions: return "questionmark.bubble"
        case .messages: return "bubble.left.and.bubble.right"
        case .settings: return "gearshape"
        }
    }
}
