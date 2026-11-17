// Decisions (cards with options, recommended first, reason shown; click or type to answer)
// and Messages (from -> to, time, text; filter by desk).
import SwiftUI
import AchDeskCore

struct DecisionsView: View {
    @EnvironmentObject var store: DeskStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                BackendBanner()
                if store.openDecisions.isEmpty {
                    ContentUnavailableView("No open decisions", systemImage: "checkmark.bubble", description: Text("The DECISIONS desk's asks for you show up here."))
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                }
                ForEach(store.openDecisions) { d in DecisionCard(d: d) }
                let answered = store.decisions.filter { !$0.isOpen }.suffix(10).reversed()
                if !answered.isEmpty {
                    Text("Recently answered").font(.headline).padding(.top)
                    ForEach(Array(answered)) { d in
                        VStack(alignment: .leading) {
                            Text("\(d.id): \(d.question)").font(.subheadline)
                            Text(d.answer.map { "\($0.by): \($0.text)" } ?? d.state).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Decisions")
    }
}

struct DecisionCard: View {
    let d: Decision
    @EnvironmentObject var store: DeskStore
    @State private var typed = ""
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(d.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                Text("asked by \(d.askedBy)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(formatTime(d.openedAt)).font(.caption2).foregroundStyle(.tertiary)
            }
            Text(d.question).font(.headline).textSelection(.enabled)
            ForEach(Array(d.orderedOptions.enumerated()), id: \.offset) { _, o in
                Button { answer(o.label) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(o.label).fontWeight(o.recommended == true ? .semibold : .regular)
                            if o.recommended == true { Text("Recommended").font(.caption2).padding(.horizontal, 5).background(.green.opacity(0.2), in: Capsule()) }
                        }
                        if let r = o.reason { Text(r).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(sending)
            }
            HStack {
                TextField("Or type an answer", text: $typed).textFieldStyle(.roundedBorder).onSubmit { answer(typed) }
                Button("Answer") { answer(typed) }.disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty || sending)
            }
        }
        .padding(12)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.separator))
    }

    func answer(_ text: String) {
        sending = true
        Task {
            await store.answer(decisionID: d.id, text: text)
            sending = false
            typed = ""
        }
    }
}

struct MessagesView: View {
    @EnvironmentObject var store: DeskStore
    @State private var filter = ""

    var names: [String] {
        Array(Set(store.messages.flatMap { [$0.from, $0.to] } + (store.roster?.rows.map(\.name) ?? []))).sorted()
    }

    var shown: [DeskMessage] {
        filter.isEmpty ? store.messages : store.messages.filter { $0.from == filter || $0.to == filter }
    }

    var body: some View {
        VStack(spacing: 0) {
            BackendBanner()
            Table(shown.reversed()) {
                TableColumn("Time") { m in Text(formatTime(m.at)).font(.caption.monospacedDigit()) }.width(min: 70, ideal: 80, max: 110)
                TableColumn("From -> To") { m in Text("\(m.from) -> \(m.to)").font(.caption.weight(.semibold)) }.width(min: 120, ideal: 160, max: 240)
                TableColumn("Text") { m in Text(m.text).lineLimit(4).textSelection(.enabled) }
            }
        }
        .navigationTitle("Messages")
        .toolbar {
            ToolbarItem {
                Picker("Desk", selection: $filter) {
                    Text("All desks").tag("")
                    ForEach(names, id: \.self) { Text($0).tag($0) }
                }
                .frame(width: 180)
            }
        }
    }
}
