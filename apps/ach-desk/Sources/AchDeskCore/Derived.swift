// Pure view-model rules (tested in AchDeskCoreTests/ViewModelTests.swift).
import Foundation

public enum Derived {
    /// Sidebar + Dock badge: open decisions (decisions list wins over the roster copy, deduped by id).
    public static func decisionBadgeCount(roster: RosterView?, decisions: [Decision]) -> Int {
        var byID: [String: Decision] = [:]
        for d in roster?.openDecisions ?? [] { byID[d.id] = d }
        for d in decisions { byID[d.id] = d } // fresher state (answered/closed) overrides
        return byID.values.filter(\.isOpen).count
    }

    /// Open decisions, oldest first.
    public static func openDecisions(roster: RosterView?, decisions: [Decision]) -> [Decision] {
        var byID: [String: Decision] = [:]
        for d in roster?.openDecisions ?? [] { byID[d.id] = d }
        for d in decisions { byID[d.id] = d }
        return byID.values.filter(\.isOpen).sorted { ($0.openedAt, $0.id) < ($1.openedAt, $1.id) }
    }

    /// Start of the local day containing `now` (epoch ms).
    public static func startOfDayMs(_ now: Date, calendar: Calendar = .current) -> Double {
        calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
    }

    /// "Cost today": the contract has no dated cost, so the rule is the summed costUsd of lanes whose
    /// startedAt is on or after local midnight (a lane's cost is its whole run's cost). Null costs count 0.
    public static func lanesCostToday(rows: [RosterRow], now: Date, calendar: Calendar = .current) -> Double {
        let midnight = startOfDayMs(now, calendar: calendar)
        return rows.filter { $0.isLane && $0.entry.startedAt >= midnight }.reduce(0) { $0 + ($1.costUsd ?? 0) }
    }

    /// Lanes still running (host alive and not stopping/error).
    public static func runningLanes(rows: [RosterRow]) -> [RosterRow] {
        rows.filter { $0.isLane && ["starting", "idle", "busy"].contains($0.state) }
    }

    /// Feed notes that mean the source is NOT live (case-insensitive substring match).
    public static let inactiveFeedWords = ["ended", "exit", "stopped", "waiting", "inactive", "not active", "idle", "closed", "error", "failed"]
    /// A feed event older than this no longer counts as "recent".
    public static let liveFeedWindowMs: Double = 10 * 60 * 1000

    /// Live-call rule: the desk row has a feedPid AND its newest "feed" event is within
    /// liveFeedWindowMs of now AND that event's note does not read as inactive (ended/waiting/...).
    /// src/desks/feeds.ts is still a stub on the base commit, so the note wording is not fixed
    /// by the contract; see README "Limitations".
    public static func isLiveCall(row: RosterRow, events: [HostEvent], now: Date) -> Bool {
        guard row.entry.feedPid != nil else { return false }
        let feed = events.filter { $0.name == row.name && $0.type == "feed" }.max { $0.at < $1.at }
        guard let last = feed else { return false }
        let nowMs = now.timeIntervalSince1970 * 1000
        guard nowMs - last.at <= liveFeedWindowMs else { return false }
        if let active = last.data["active"]?.boolValue { return active }
        let note = (last.data["note"]?.stringValue ?? "").lowercased()
        return !inactiveFeedWords.contains { note.contains($0) }
    }

    public static func liveCallDesks(rows: [RosterRow], eventsByDesk: [String: [HostEvent]], now: Date) -> [String] {
        rows.filter { isLiveCall(row: $0, events: eventsByDesk[$0.name] ?? [], now: now) }.map(\.name)
    }

    /// Talking-points HUD: the latest assistant `text` event of the listener desk. The listener is the
    /// desk named LISTENER, else the desk whose role is "listener", else the first desk with a feed.
    public static func listenerName(rows: [RosterRow]) -> String? {
        let desks = rows.filter { !$0.isLane }
        return desks.first { $0.name == "LISTENER" }?.name
            ?? desks.first { $0.entry.role.lowercased() == "listener" }?.name
            ?? desks.first { $0.entry.feedPid != nil }?.name
    }

    public static func latestText(events: [HostEvent]) -> String? {
        events.filter { $0.type == "text" }.max { ($0.at, $0.seq) < ($1.at, $1.seq) }?.data["text"]?.stringValue
    }

    /// Lane goal transitions worth a notification (achieved / blocked), comparing two roster snapshots.
    public static func laneTransitions(old: [RosterRow], new: [RosterRow]) -> [(name: String, state: String)] {
        let before = Dictionary(old.map { ($0.name, $0.goalStatus?.state) }, uniquingKeysWith: { a, _ in a })
        return new.filter(\.isLane).compactMap { row in
            guard let st = row.goalStatus?.state, st == "achieved" || st == "blocked" else { return nil }
            if let prev = before[row.name], prev == st { return nil }
            return (row.name, st)
        }
    }

    /// Plan progress "n/m" for lane cards.
    public static func planText(_ g: GoalStatus?) -> String? {
        guard let p = g?.plan else { return nil }
        return "\(p.verified)/\(p.total)"
    }

    /// Fraction of budget used, clamped to 0...1 (nil without a budget).
    public static func budgetFraction(cost: Double?, budget: Double?) -> Double? {
        guard let b = budget, b > 0 else { return nil }
        return min(1, max(0, (cost ?? 0) / b))
    }

    public static func elapsedText(startedAtMs: Double, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince1970 - startedAtMs / 1000))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    public static func costText(_ c: Double?) -> String {
        guard let c else { return "-" }
        return String(format: "$%.2f", c)
    }
}

// MARK: - Notifications mapping (pure; the app target wires it to UNUserNotificationCenter)

public enum NotificationPlan {
    public static let maxOptionActions = 3
    public static let replyActionID = "reply"
    public static let optionPrefix = "opt."
    public static let laneCategoryID = "lane"
    public static let laneOpenActionID = "lane.open"
    public static let laneStopActionID = "lane.stop"

    public struct Action: Equatable, Sendable {
        public var id: String
        public var title: String
        public var isTextInput: Bool
    }

    public struct Category: Equatable, Sendable {
        public var id: String
        public var actions: [Action]
    }

    public static func categoryID(decisionID: String) -> String { "decision.\(decisionID)" }

    /// One category per open decision: up to 3 option buttons (recommended first) + a text reply.
    public static func category(for d: Decision) -> Category {
        let opts = d.orderedOptions.prefix(maxOptionActions).enumerated().map { i, o in
            Action(id: "\(optionPrefix)\(i)", title: o.recommended == true ? "\(o.label) (recommended)" : o.label, isTextInput: false)
        }
        return Category(id: categoryID(decisionID: d.id), actions: Array(opts) + [Action(id: replyActionID, title: "Reply...", isTextInput: true)])
    }

    public static func laneCategory() -> Category {
        Category(id: laneCategoryID, actions: [
            Action(id: laneOpenActionID, title: "Open", isTextInput: false),
            Action(id: laneStopActionID, title: "Stop", isTextInput: false),
        ])
    }

    /// Notification response -> the answer text to POST /decisions/:id/answer, or nil (dismissed,
    /// default tap, empty reply, unknown action).
    public static func answerText(for d: Decision, actionID: String, userText: String?) -> String? {
        if actionID == replyActionID {
            let t = (userText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        guard actionID.hasPrefix(optionPrefix), let i = Int(actionID.dropFirst(optionPrefix.count)) else { return nil }
        let opts = d.orderedOptions
        guard i >= 0, i < min(opts.count, maxOptionActions) else { return nil }
        return opts[i].label
    }

    public enum LaneAction: Equatable, Sendable { case open(String), stop(String) }

    public static func laneAction(actionID: String, laneName: String) -> LaneAction? {
        switch actionID {
        case laneOpenActionID: return .open(laneName)
        case laneStopActionID: return .stop(laneName)
        default: return nil
        }
    }
}
