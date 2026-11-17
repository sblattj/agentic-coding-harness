// Main window: NavigationSplitView with Desks, Lanes, Decisions, Messages, Settings.
import SwiftUI
import AchDeskCore

struct ContentView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        NavigationSplitView {
            List(SidebarSection.allCases, selection: $model.section) { s in
                Label(s.rawValue, systemImage: s.icon)
                    .badge(s == .decisions ? store.decisionBadge : (s == .lanes ? store.pendingLanes.count : 0))
                    .tag(s)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
            .safeAreaInset(edge: .bottom) { ConnectionFooter().padding(8) }
        } detail: {
            switch model.section ?? .desks {
            case .desks: DesksView()
            case .lanes: LanesView()
            case .decisions: DecisionsView()
            case .messages: MessagesView()
            case .settings: SettingsView()
            }
        }
        .onAppear { model.openWindowAction = { id in openWindow(id: id) } }
    }
}

struct ConnectionFooter: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var store: DeskStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(label).font(.caption)
            }
            if let e = store.lastError {
                Text(e).font(.caption2).foregroundStyle(.red).lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var label: String {
        if model.booting { return "Starting ach web..." }
        if case .failed = model.bootOutcome { return "Backend unavailable" }
        switch store.streamStatus {
        case .connected: return "Live (SSE) on :\(model.settings.port)"
        case .connecting: return "Connecting..."
        case .disconnected: return store.polling ? "Polling every 2 s" : "Reconnecting..."
        case .stopped: return "Stopped"
        }
    }

    var color: Color {
        if case .failed = model.bootOutcome { return .red }
        switch store.streamStatus {
        case .connected: return .green
        case .disconnected: return store.polling && store.roster != nil ? .yellow : .orange
        default: return .gray
        }
    }
}

/// Shown when the backend could not be reached / started.
struct BackendBanner: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if case .failed(let msg) = model.bootOutcome {
            HStack(alignment: .top) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(msg).font(.callout).textSelection(.enabled)
                Spacer()
                Button("Retry") { model.connect() }.disabled(model.booting)
            }
            .padding(10)
            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            .padding([.horizontal, .top])
        }
    }
}

func formatTime(_ ms: Double) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    let f = DateFormatter()
    f.dateFormat = Calendar.current.isDateInToday(d) ? "HH:mm:ss" : "MMM d HH:mm"
    return f.string(from: d)
}

func stateColor(_ s: String) -> Color {
    switch s {
    case "busy", "active": return .blue
    case "idle", "achieved": return .green
    case "starting": return .teal
    case "stopping", "stopped": return .gray
    case "error", "blocked": return .orange
    case "dead": return .red
    default: return .secondary
    }
}

struct StatePill: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(stateColor(text).opacity(0.18), in: Capsule())
            .foregroundStyle(stateColor(text))
    }
}
