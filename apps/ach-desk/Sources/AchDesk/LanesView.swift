// Lanes: pending approvals, lane cards (goal, status, plan n/m, elapsed, cost, budget bar, Stop),
// and the New lane sheet (POST /api/desks/lanes).
import SwiftUI
import AppKit
import AchDeskCore

struct LanesView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @State private var showNew = false
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    BackendBanner()
                    if !store.pendingLanes.isEmpty {
                        Text("Waiting for approval").font(.headline)
                        ForEach(store.pendingLanes) { p in PendingLaneRow(p: p) }
                    }
                    Text("Lanes").font(.headline)
                    if store.lanes.isEmpty {
                        Text("No lanes. Start one with New lane.").foregroundStyle(.secondary)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 12)], spacing: 12) {
                        ForEach(store.lanes) { row in
                            LaneCard(row: row, now: store.now, highlighted: model.focusLane == row.name, open: { path.append(row.name) }) {
                                Task { await store.stopLane(row.name) }
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Lanes")
            .navigationDestination(for: String.self) { name in DeskChatView(name: name) }
            .toolbar {
                ToolbarItem {
                    Button { showNew = true } label: { Label("New lane", systemImage: "plus") }.disabled(store.roster == nil)
                }
            }
            .sheet(isPresented: $showNew) { NewLaneSheet().environmentObject(model).environmentObject(store) }
            .onChange(of: model.focusLane) { _, lane in if let lane { path = [lane] } }
        }
    }
}

struct PendingLaneRow: View {
    let p: PendingLane
    @EnvironmentObject var store: DeskStore

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(p.id): \(p.request.name)").font(.subheadline.weight(.semibold))
                Text(p.request.goal).font(.caption).lineLimit(3)
                Text("asked by \(p.request.launchedBy) at \(formatTime(p.requestedAt))").font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Approve") { Task { await store.approve(p.id) } }.buttonStyle(.borderedProminent)
            Button("Reject") { Task { await store.reject(p.id, reason: nil) } }
        }
        .padding(10)
        .background(.yellow.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct LaneCard: View {
    let row: RosterRow
    let now: Date
    var highlighted = false
    let open: () -> Void
    let stop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(row.name).font(.headline)
                Spacer()
                StatePill(text: row.goalStatus?.state ?? row.state)
            }
            Text(row.entry.goal ?? row.goalStatus?.objective ?? "(no goal)").font(.caption).lineLimit(3)
            HStack(spacing: 12) {
                if let plan = Derived.planText(row.goalStatus) { Label(plan, systemImage: "checklist") }
                Label(Derived.elapsedText(startedAtMs: row.entry.startedAt, now: now), systemImage: "clock")
                Label(Derived.costText(row.treeCostUsd ?? row.costUsd), systemImage: "dollarsign.circle")
                Text(row.entry.agent).foregroundStyle(.secondary)
            }
            .font(.caption)
            if let f = Derived.budgetFraction(cost: row.treeCostUsd ?? row.costUsd, budget: row.entry.budgetUsd) {
                ProgressView(value: f) { Text("Budget \(Derived.costText(row.entry.budgetUsd))").font(.caption2) }
                    .tint(f > 0.9 ? .red : (f > 0.7 ? .orange : .accentColor))
            }
            if let reason = row.goalStatus?.reason, row.goalStatus?.state == "blocked" {
                Text(reason).font(.caption).foregroundStyle(.orange).lineLimit(3)
            }
            HStack {
                Button("Open", action: open)
                Spacer()
                Button("Stop", role: .destructive, action: stop).disabled(!row.isAlive)
            }
        }
        .padding(12)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(highlighted ? Color.accentColor : Color.gray.opacity(0.3), lineWidth: highlighted ? 2 : 1))
    }
}

struct NewLaneSheet: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var goal = ""
    @State private var tools: Set<String> = []
    @State private var folder = ""
    @State private var budget = ""
    @State private var agent = ""
    @State private var modelID = ""
    @State private var submitting = false
    @State private var result: String?

    var engineChoices: [String] { store.engines.filter(\.found).map(\.agent) }

    var nameOK: Bool { NewLaneBody.isValidName(name) && !(store.roster?.rows.contains { $0.name.lowercased() == name.lowercased() } ?? false) }
    var budgetValue: Double? { Double(budget.trimmingCharacters(in: .whitespaces)) }
    var canSubmit: Bool { nameOK && !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (budget.isEmpty || budgetValue != nil) && !submitting }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New lane").font(.title2.bold())
            Form {
                TextField("Name", text: $name, prompt: Text("e.g. fix-login-timeout"))
                if !name.isEmpty && !nameOK {
                    Text("Letters, digits, _ or -, starting with a letter or digit, max 48, not human, not already in use.").font(.caption).foregroundStyle(.red)
                }
                VStack(alignment: .leading) {
                    Text("Goal")
                    TextEditor(text: $goal).frame(minHeight: 90).border(.separator)
                }
                Section("Tools (MCP servers)") {
                    if store.mcpNames.isEmpty { Text("No MCP names reported; the lane gets the stack's defaults.").font(.caption).foregroundStyle(.secondary) }
                    ForEach(store.mcpNames, id: \.self) { n in
                        Toggle(n, isOn: Binding(get: { tools.contains(n) }, set: { on in if on { tools.insert(n) } else { tools.remove(n) } }))
                    }
                }
                HStack {
                    TextField("Working folder", text: $folder, prompt: Text("default: the stack's folder"))
                    Button("Choose...") { pickFolder() }
                }
                TextField("Budget (USD)", text: $budget, prompt: Text("optional"))
                Picker("Engine", selection: $agent) {
                    Text(defaultEngineLabel).tag("")
                    ForEach(engineChoices, id: \.self) { Text($0).tag($0) }
                }
                TextField("Model", text: $modelID, prompt: Text("optional, e.g. claude-sonnet-5-5"))
            }
            .formStyle(.grouped)
            if let result { Text(result).font(.callout).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Start lane") { submit() }.keyboardShortcut(.defaultAction).disabled(!canSubmit)
            }
        }
        .padding()
        .frame(width: 520, height: 640)
        .onAppear {
            agent = model.settings.defaultLaneAgent
            modelID = model.settings.defaultLaneModel
            if name.isEmpty { name = suggestedName() }
            Task { await store.refreshAll() }
        }
    }

    var defaultEngineLabel: String {
        model.settings.defaultLaneAgent.isEmpty ? "Default (layout)" : "Default (\(model.settings.defaultLaneAgent))"
    }

    func suggestedName() -> String {
        let used = Set(store.roster?.rows.map(\.name) ?? [])
        var i = 1
        while used.contains("LANE\(i)") { i += 1 }
        return "LANE\(i)"
    }

    func pickFolder() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.allowsMultipleSelection = false
        if p.runModal() == .OK, let url = p.url { folder = url.path }
    }

    func submit() {
        let chosenAgent = agent.isEmpty ? model.settings.defaultLaneAgent : agent
        let body = NewLaneBody(
            name: name,
            goal: goal.trimmingCharacters(in: .whitespacesAndNewlines),
            mcps: tools.isEmpty ? nil : tools.sorted(),
            cwd: folder.isEmpty ? nil : folder,
            agent: chosenAgent.isEmpty ? nil : chosenAgent,
            model: modelID.isEmpty ? nil : modelID,
            budgetUsd: budgetValue
        )
        submitting = true
        Task {
            let r = await store.newLane(body)
            submitting = false
            switch r {
            case .started(let e)?: result = "Started \(e.name) on \(e.agent)."; dismiss()
            case .pending(let p)?: result = "Waiting for approval as \(p.id)."; dismiss()
            case nil: result = store.lastError ?? "Failed."
            }
        }
    }
}
