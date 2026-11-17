// Desks: grid of desk cards -> chat view per desk (messages + host events, a send box).
import SwiftUI
import AppKit
import AchDeskCore

struct DesksView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                BackendBanner()
                if store.desks.isEmpty {
                    ContentUnavailableView {
                        Label("No desks running", systemImage: "rectangle.grid.2x2")
                    } description: {
                        Text(store.roster == nil ? "Waiting for ach web..." : "Start the default layout (ach desk up) to bring the desks up.")
                    } actions: {
                        Button("Start stack") { Task { await store.up() } }.disabled(store.roster == nil)
                    }
                } else {
                    ScrollView {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 12)], spacing: 12) {
                            ForEach(store.desks) { row in
                                NavigationLink(value: row.name) { DeskCard(row: row, live: store.liveCallDesks.contains(row.name)) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Desks")
            .navigationDestination(for: String.self) { name in DeskChatView(name: name) }
            .toolbar {
                ToolbarItemGroup {
                    Button { Task { await store.up() } } label: { Label("Start stack", systemImage: "play.fill") }
                    Button { Task { await store.down() } } label: { Label("Stop stack", systemImage: "stop.fill") }
                    Button { model.hud.toggle() } label: { Label("Talking points", systemImage: "text.bubble") }
                }
            }
        }
    }
}

struct DeskCard: View {
    let row: RosterRow
    var live = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(row.name).font(.headline)
                if live { Label("live", systemImage: "dot.radiowaves.left.and.right").font(.caption).foregroundStyle(.red) }
                Spacer()
                StatePill(text: row.state)
            }
            Text(row.entry.role).font(.subheadline).foregroundStyle(.secondary)
            Divider()
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
                GridRow { Text("Engine").foregroundStyle(.secondary); Text("\(row.entry.agent) (\(row.entry.engine))") }
                GridRow { Text("Model").foregroundStyle(.secondary); Text(row.entry.model ?? "default") }
                GridRow { Text("Queue").foregroundStyle(.secondary); Text("\(row.queueDepth)") }
                GridRow { Text("Cost").foregroundStyle(.secondary); Text(Derived.costText(row.treeCostUsd ?? row.costUsd)) }
            }
            .font(.caption)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
    }
}

/// One timeline line: a message to/from the desk, or a displayable host event.
struct TimelineItem: Identifiable {
    var id: String
    var at: Double
    var title: String
    var text: String
    var isMessage: Bool
    var fromHuman: Bool
}

struct DeskChatView: View {
    let name: String
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @State private var draft = ""
    @State private var showRaw = false

    var row: RosterRow? { store.roster?.rows.first { $0.name == name } }

    var items: [TimelineItem] {
        let msgs = store.messages.filter { $0.from == name || $0.to == name }.map {
            TimelineItem(id: "m.\($0.id)", at: $0.at, title: "\($0.from) -> \($0.to)\($0.delivered == "queued" ? " (queued)" : "")", text: $0.text, isMessage: true, fromHuman: $0.from == "human")
        }
        let evs = (store.eventsByDesk[name] ?? []).compactMap { e -> TimelineItem? in
            guard let t = e.displayText else { return nil }
            return TimelineItem(id: "e.\(e.id)", at: e.at, title: e.type, text: t, isMessage: false, fromHuman: false)
        }
        return (msgs + evs).sorted { $0.at < $1.at }
    }

    var attachArgv: [String] {
        let ach = model.settings.achPath.isEmpty ? "ach" : model.settings.achPath
        return [ach, "desk", "chat", name]
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if showRaw { rawPanel.padding([.horizontal, .bottom]) }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(items) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(item.title).font(.caption.weight(.semibold)).foregroundStyle(item.isMessage ? .primary : .secondary)
                                    Spacer()
                                    Text(formatTime(item.at)).font(.caption2).foregroundStyle(.tertiary)
                                }
                                Text(item.text)
                                    .font(item.isMessage ? .body : .callout)
                                    .foregroundStyle(item.isMessage ? .primary : .secondary)
                                    .textSelection(.enabled)
                            }
                            .padding(8)
                            .background(item.fromHuman ? Color.accentColor.opacity(0.12) : (item.isMessage ? Color.gray.opacity(0.08) : .clear), in: RoundedRectangle(cornerRadius: 8))
                            .id(item.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: items.count) { _, _ in if let last = items.last { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
            Divider()
            HStack {
                TextField("Message \(name)", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(sendDraft)
                Button("Send", action: sendDraft).keyboardShortcut(.return, modifiers: [.command]).disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding()
        }
        .navigationTitle(name)
        .task(id: name) {
            await store.loadEvents(desk: name)
            if store.messages.isEmpty { await store.refreshAll() }
        }
    }

    var header: some View {
        HStack(alignment: .top) {
            if let row {
                VStack(alignment: .leading, spacing: 2) {
                    HStack { Text(row.entry.role).font(.headline); StatePill(text: row.state) }
                    Text("\(row.entry.agent) / \(row.entry.model ?? "default model")  -  queue \(row.queueDepth)  -  \(Derived.costText(row.treeCostUsd ?? row.costUsd))")
                        .font(.caption).foregroundStyle(.secondary)
                    if let g = row.goalStatus, !g.objective.isEmpty {
                        Text("Goal (\(g.state)): \(g.objective)").font(.caption).lineLimit(2)
                    }
                }
            }
            Spacer()
            Button(showRaw ? "Hide raw" : "Raw terminal...") { showRaw.toggle() }
        }
        .padding()
    }

    var rawPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("An embedded terminal is not in this build. Run this in a terminal to attach:").font(.caption)
            HStack {
                Text(attachArgv.joined(separator: " ")).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(attachArgv.joined(separator: " "), forType: .string)
                }
            }
            if let url = row?.entry.engineUrl {
                Text("Engine URL: \(url)").font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
            }
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    func sendDraft() {
        let text = draft
        draft = ""
        Task { await store.send(to: name, text: text) }
    }
}
