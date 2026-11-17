// Actionable notifications: one category per open decision (option buttons + text reply) and a
// lane category (Open / Stop). Answer and Stop actions are not .foreground, so answering from the
// banner POSTs without opening the window. UNUserNotificationCenter needs a bundle id: in an
// unbundled `swift run` this whole class is a no-op.
import AppKit
import UserNotifications
import AchDeskCore

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onAnswer: ((String, String) async -> Void)?
    var onLaneAction: ((NotificationPlan.LaneAction) async -> Void)?
    var decisionLookup: ((String) -> Decision?)?

    private var knownDecisions: [String: Decision] = [:]

    var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    private var center: UNUserNotificationCenter? { available ? UNUserNotificationCenter.current() : nil }

    func setUp() {
        guard let center else { return }
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        registerCategories([])
    }

    /// setNotificationCategories replaces the whole set, so every call re-registers all open decisions.
    func registerCategories(_ open: [Decision]) {
        for d in open { knownDecisions[d.id] = d }
        guard let center else { return }
        var cats = Set<UNNotificationCategory>()
        for d in open { cats.insert(Self.make(NotificationPlan.category(for: d))) }
        cats.insert(Self.make(NotificationPlan.laneCategory(), foregroundIDs: [NotificationPlan.laneOpenActionID]))
        center.setNotificationCategories(cats)
    }

    static func make(_ c: NotificationPlan.Category, foregroundIDs: Set<String> = []) -> UNNotificationCategory {
        let actions: [UNNotificationAction] = c.actions.map { a in
            let opts: UNNotificationActionOptions = foregroundIDs.contains(a.id) ? [.foreground] : []
            if a.isTextInput {
                return UNTextInputNotificationAction(identifier: a.id, title: a.title, options: opts, textInputButtonTitle: "Answer", textInputPlaceholder: "Your answer")
            }
            return UNNotificationAction(identifier: a.id, title: a.title, options: opts)
        }
        return UNNotificationCategory(identifier: c.id, actions: actions, intentIdentifiers: [], options: [])
    }

    func postDecision(_ d: Decision) {
        knownDecisions[d.id] = d
        guard let center else { return }
        registerCategories(Array(knownDecisions.values.filter(\.isOpen)))
        let content = UNMutableNotificationContent()
        content.title = "Decision \(d.id) from \(d.askedBy)"
        content.body = d.question
        content.categoryIdentifier = NotificationPlan.categoryID(decisionID: d.id)
        content.userInfo = ["decisionID": d.id]
        content.sound = .default
        center.add(UNNotificationRequest(identifier: "decision.\(d.id)", content: content, trigger: nil))
    }

    func postLane(name: String, state: String) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "Lane \(name) \(state)"
        content.body = state == "achieved" ? "The lane reached its goal." : "The lane is blocked and needs a hand."
        content.categoryIdentifier = NotificationPlan.laneCategoryID
        content.userInfo = ["lane": name]
        content.sound = .default
        center.add(UNNotificationRequest(identifier: "lane.\(name).\(state)", content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let actionID = response.actionIdentifier
        let userText = (response as? UNTextInputNotificationResponse)?.userText
        let decisionID = info["decisionID"] as? String
        let lane = info["lane"] as? String
        Task { @MainActor in
            defer { completionHandler() }
            if let decisionID {
                guard let d = self.decisionLookup?(decisionID) ?? self.knownDecisions[decisionID] else { return }
                if let text = NotificationPlan.answerText(for: d, actionID: actionID, userText: userText) {
                    await self.onAnswer?(decisionID, text)
                } else if actionID == UNNotificationDefaultActionIdentifier {
                    NSApp.activate(ignoringOtherApps: true)
                }
            } else if let lane {
                let action = NotificationPlan.laneAction(actionID: actionID, laneName: lane)
                    ?? (actionID == UNNotificationDefaultActionIdentifier ? .open(lane) : nil)
                if let action { await self.onLaneAction?(action) }
            }
        }
    }
}
