// Settings (ach path, port, token, state dir, engines found, default engine/model per role, per-desk
// engine switch via POST /api/desks/:name/engine) and the menu bar extra.
import SwiftUI
import AppKit
import AchDeskCore

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @State private var draft = AppSettings()
    @State private var portText = ""
    @State private var loaded = false

    var engineChoices: [String] { store.engines.filter(\.found).map(\.agent) }

    var body: some View {
        Form {
            Section("Backend (ach web)") {
                HStack {
                    TextField("ach path", text: $draft.achPath, prompt: Text("auto: login-shell PATH, then bundled"))
                    Button("Choose...") { pickFile() }
                }
                TextField("Port", text: $portText)
                SecureField("Token", text: $draft.token, prompt: Text("none (loopback, unauthenticated)"))
                HStack {
                    TextField("State directory", text: $draft.stateDir, prompt: Text("default: ~/.agentic-coding-harness"))
                    Button("Choose...") { pickFolder() }
                }
                Toggle("Start ach web when none is serving", isOn: $draft.autoStartBackend)
                Toggle("Start the default layout on launch when no desks run", isOn: $draft.startStackOnLaunch)
                Toggle("Stop the stack on quit (only if this app started ach web)", isOn: $draft.stopStackOnQuit)
                HStack {
                    Text(model.bootOutcome?.note ?? "").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    Spacer()
                    Button("Show log") { NSWorkspace.shared.activateFileViewerSelecting([model.backend.logURL]) }
                    Button("Apply") { apply() }.keyboardShortcut(.defaultAction)
                }
            }

            Section("Engines found") {
                if store.engines.isEmpty { Text("Not reported yet (GET /api/desks/engines).").foregroundStyle(.secondary) }
                ForEach(store.engines) { e in
                    HStack {
                        Image(systemName: e.found ? "checkmark.circle.fill" : "xmark.circle").foregroundStyle(e.found ? .green : .secondary)
                        Text(e.agent).frame(width: 100, alignment: .leading)
                        Text(e.path ?? "not on PATH").font(.caption.monospaced()).foregroundStyle(.secondary)
                        Spacer()
                        Text(e.auth ?? "").font(.caption)
                    }
                }
            }

            Section("New lanes") {
                Picker("Default engine", selection: $draft.defaultLaneAgent) {
                    Text("Layout default").tag("")
                    ForEach(engineChoices, id: \.self) { Text($0).tag($0) }
                }
                TextField("Default model", text: $draft.defaultLaneModel, prompt: Text("layout default"))
            }

            Section("Engine per desk role") {
                Text("Changing a desk's engine sends POST /api/desks/:name/engine; ach web applies it to that desk.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(store.desks) { row in DeskEngineRow(row: row, choices: engineChoices) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .onAppear {
            if !loaded { draft = model.settings; portText = String(model.settings.port); loaded = true }
            Task { await store.refreshAll() }
        }
    }

    func apply() {
        var s = draft
        if let p = Int(portText), (1...65535).contains(p) { s.port = p } else { portText = String(s.port) }
        model.applySettings(s)
    }

    func pickFile() {
        let p = NSOpenPanel()
        p.canChooseFiles = true
        p.canChooseDirectories = false
        if p.runModal() == .OK, let url = p.url { draft.achPath = url.path }
    }

    func pickFolder() {
        let p = NSOpenPanel()
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        if p.runModal() == .OK, let url = p.url { draft.stateDir = url.path }
    }
}

struct DeskEngineRow: View {
    let row: RosterRow
    let choices: [String]
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @State private var agent = ""
    @State private var modelID = ""
    @State private var busy = false

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(row.name).font(.subheadline.weight(.semibold))
                Text("role \(row.entry.role) - now \(row.entry.agent)\(row.entry.model.map { " / \($0)" } ?? "")").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Picker("", selection: $agent) {
                ForEach(Array(Set(choices + [row.entry.agent])).sorted(), id: \.self) { Text($0).tag($0) }
            }
            .frame(width: 130)
            TextField("model", text: $modelID).frame(width: 170)
            Button(busy ? "Restarting..." : "Apply") { apply() }
                .disabled(busy || (agent == row.entry.agent && modelID == (row.entry.model ?? "")))
        }
        .onAppear {
            let saved = model.settings.roleEngines[row.entry.role]
            agent = saved?.agent ?? row.entry.agent
            modelID = saved?.model ?? row.entry.model ?? ""
        }
    }

    func apply() {
        busy = true
        let m = modelID.isEmpty ? nil : modelID
        var s = model.settings
        s.roleEngines[row.entry.role] = EngineChoice(agent: agent, model: m)
        model.applySettings(s)
        Task {
            await store.setEngine(desk: row.name, agent: agent, model: m)
            busy = false
        }
    }
}

struct MenuBarLabel: View {
    @EnvironmentObject var store: DeskStore

    var body: some View {
        let n = store.decisionBadge
        let live = !store.liveCallDesks.isEmpty
        HStack(spacing: 2) {
            Image(systemName: live ? "dot.radiowaves.left.and.right" : "rectangle.grid.2x2")
            if n > 0 { Text("\(n)") }
        }
    }
}

struct MenuBarView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("ach Desk").font(.headline)
                Spacer()
                Text(store.isConnected ? "connected" : "offline").font(.caption).foregroundStyle(store.isConnected ? .green : .secondary)
            }
            Divider()
            Button {
                model.section = .decisions
                open()
            } label: {
                Label("\(store.decisionBadge) pending decision\(store.decisionBadge == 1 ? "" : "s")", systemImage: "questionmark.bubble")
            }
            .buttonStyle(.plain)
            HStack {
                Circle().fill(store.liveCallDesks.isEmpty ? Color.gray : Color.red).frame(width: 8, height: 8)
                Text(store.liveCallDesks.isEmpty ? "No live call" : "Live call: \(store.liveCallDesks.joined(separator: ", "))").font(.callout)
            }
            Text("Running lanes: \(store.runningLanes.count)  -  cost today \(Derived.costText(store.costToday))").font(.callout)
            ForEach(store.runningLanes.prefix(6)) { l in
                HStack {
                    Text(l.name).font(.caption.weight(.semibold))
                    Text(l.goalStatus?.state ?? l.state).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(Derived.costText(l.treeCostUsd ?? l.costUsd)).font(.caption.monospacedDigit())
                }
            }
            Divider()
            HStack {
                Button("Open window") { open() }
                Spacer()
                Button("Start stack") { Task { await store.up() } }
                Button("Stop stack") { Task { await store.down() } }
            }
            HStack {
                Button("Talking points HUD") { model.hud.toggle() }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(12)
        .frame(width: 320)
        .onAppear { model.openWindowAction = { id in openWindow(id: id) } }
    }

    func open() {
        openWindow(id: AppModel.mainWindowID)
        NSApp.activate(ignoringOtherApps: true)
    }
}
