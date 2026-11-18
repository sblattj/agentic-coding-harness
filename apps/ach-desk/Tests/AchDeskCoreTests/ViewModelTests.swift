import Foundation
import Testing
@testable import AchDeskCore

@Suite struct ViewModelTests {
    let roster = try! JSONDecoder().decode(RosterView.self, from: Fixtures.data(Fixtures.rosterView))
    let events = try! JSONDecoder().decode(EventsResponse.self, from: Fixtures.data(Fixtures.events)).events
    var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }

    func decision(_ id: String, state: String = "open", at: Double = 1) -> Decision {
        Decision(id: id, question: "q\(id)", options: [], askedBy: "X", openedAt: at, state: state)
    }

    // MARK: decision badge

    @Test func badgeCountsOpenDecisionsDedupedAcrossRosterAndList() {
        #expect(Derived.decisionBadgeCount(roster: roster, decisions: []) == 1)
        // the list says D1 is answered (fresher) and adds an open D2
        let list = try! JSONDecoder().decode(DecisionsResponse.self, from: Fixtures.data(Fixtures.decisions)).decisions
        #expect(Derived.decisionBadgeCount(roster: roster, decisions: list) == 1)
        #expect(Derived.openDecisions(roster: roster, decisions: list).map(\.id) == ["D2"])
        #expect(Derived.decisionBadgeCount(roster: nil, decisions: [decision("D1"), decision("D2"), decision("D3", state: "closed")]) == 2)
        #expect(Derived.decisionBadgeCount(roster: nil, decisions: []) == 0)
    }

    // MARK: cost today

    @Test func lanesCostTodayCountsOnlyLanesStartedSinceLocalMidnight() {
        // LANE1 started 11:00 UTC today ($1.50), LANE0 yesterday (null cost), LISTENER is a desk ($0.42 not counted)
        #expect(Derived.lanesCostToday(rows: roster.rows, now: Fixtures.noon, calendar: utc) == 1.5)
        // the next day nothing started yet
        #expect(Derived.lanesCostToday(rows: roster.rows, now: Fixtures.noon.addingTimeInterval(86400), calendar: utc) == 0)
        // local midnight decides "today": in UTC-12 the day starts at 12:00Z
        var kiri = Calendar(identifier: .gregorian); kiri.timeZone = TimeZone(secondsFromGMT: -12 * 3600)!
        // at 12:00Z it is 00:00 on 11-17 in UTC-12, midnight = 12:00Z, so LANE1 (11:00Z) is "yesterday"
        #expect(Derived.lanesCostToday(rows: roster.rows, now: Fixtures.noon, calendar: kiri) == 0)
    }

    @Test func runningLanesExcludeDeadAndDesks() {
        #expect(Derived.runningLanes(rows: roster.rows).map(\.name) == ["LANE1"])
    }

    // MARK: live-call indicator

    @Test func liveCallNeedsFeedPidAndRecentActiveFeedEvent() {
        let desk = roster.rows[0]
        #expect(Derived.isLiveCall(row: desk, events: events, now: Fixtures.noon))
        // too old: 11 minutes after the feed event
        let later = Date(timeIntervalSince1970: (1763380400000 + 11 * 60_000) / 1000)
        #expect(!Derived.isLiveCall(row: desk, events: events, now: later))
        // no feedPid
        var noFeed = desk
        noFeed.entry.feedPid = nil
        #expect(!Derived.isLiveCall(row: noFeed, events: events, now: Fixtures.noon))
        // latest feed note says the call ended
        let ended = events + [HostEvent(seq: 9, at: 1763380790000, runId: "run-listener", name: "LISTENER", type: "feed", data: ["note": .string("call_ended: closing message sent")])]
        #expect(!Derived.isLiveCall(row: desk, events: ended, now: Fixtures.noon))
        // a waiting note on the first heartbeat is not live either
        let waiting = [HostEvent(seq: 1, at: 1763380700000, runId: "r", name: "LISTENER", type: "feed", data: ["note": .string("waiting for a call")])]
        #expect(!Derived.isLiveCall(row: desk, events: waiting, now: Fixtures.noon))
        // an explicit boolean wins when the host sends one
        let explicit = [HostEvent(seq: 1, at: 1763380700000, runId: "r", name: "LISTENER", type: "feed", data: ["note": .string("waiting"), "active": .bool(true)])]
        #expect(Derived.isLiveCall(row: desk, events: explicit, now: Fixtures.noon))
        // no feed events at all
        #expect(!Derived.isLiveCall(row: desk, events: events.filter { $0.type != "feed" }, now: Fixtures.noon))
        #expect(Derived.liveCallDesks(rows: roster.rows, eventsByDesk: ["LISTENER": events], now: Fixtures.noon) == ["LISTENER"])
    }

    @Test func liveCallRejectsFutureFeedTimestamps() {
        let desk = roster.rows[0]
        let beforeEvent = Date(timeIntervalSince1970: (1763380400000 - 60_000) / 1000)
        #expect(!Derived.isLiveCall(row: desk, events: events, now: beforeEvent))
    }

    @Test func sinceQueryOmitsNonFiniteAndOutOfRangeValues() {
        #expect(APIClient.sinceQuery(nil).isEmpty)
        #expect(APIClient.sinceQuery(.nan).isEmpty)
        #expect(APIClient.sinceQuery(.infinity).isEmpty)
        #expect(APIClient.sinceQuery(-.infinity).isEmpty)
        #expect(APIClient.sinceQuery(1e30).isEmpty)
        #expect(APIClient.sinceQuery(-1e30).isEmpty)
        #expect(APIClient.sinceQuery(9223372036854775808.0).isEmpty)
        #expect(APIClient.sinceQuery(1763380400000.7).map(\.value) == ["1763380400000"])
    }

    @Test func listenerAndLatestTalkingPoint() {
        #expect(Derived.listenerName(rows: roster.rows) == "LISTENER")
        #expect(Derived.latestText(events: events) == "Talking point A")
        let newer = events + [HostEvent(seq: 10, at: 1763380799000, runId: "run-listener", name: "LISTENER", type: "text", data: ["text": .string("Talking point B")])]
        #expect(Derived.latestText(events: newer) == "Talking point B")
    }

    // MARK: notification mapping

    @Test func decisionCategoryHasRecommendedFirstMaxThreeOptionsPlusReply() {
        let d = roster.openDecisions[0]
        let c = NotificationPlan.category(for: d)
        #expect(c.id == "decision.D1")
        #expect(c.actions.map(\.id) == ["opt.0", "opt.1", "opt.2", "reply"])
        #expect(c.actions[0].title == "Ship it (recommended)")
        #expect(c.actions[1].title == "Wait for review")
        #expect(c.actions[3].isTextInput)
    }

    @Test func notificationActionMapsToAnswerText() {
        let d = roster.openDecisions[0]
        #expect(NotificationPlan.answerText(for: d, actionID: "opt.0", userText: nil) == "Ship it")
        #expect(NotificationPlan.answerText(for: d, actionID: "opt.2", userText: nil) == "Cancel")
        #expect(NotificationPlan.answerText(for: d, actionID: "opt.3", userText: nil) == nil) // 4th option has no button
        #expect(NotificationPlan.answerText(for: d, actionID: "reply", userText: "  Ask Bob first ") == "Ask Bob first")
        #expect(NotificationPlan.answerText(for: d, actionID: "reply", userText: "   ") == nil)
        #expect(NotificationPlan.answerText(for: d, actionID: "com.apple.UNNotificationDefaultActionIdentifier", userText: nil) == nil)
        #expect(NotificationPlan.answerText(for: d, actionID: "opt.x", userText: nil) == nil)
        #expect(NotificationPlan.laneAction(actionID: "lane.stop", laneName: "LANE1") == .stop("LANE1"))
        #expect(NotificationPlan.laneAction(actionID: "lane.open", laneName: "LANE1") == .open("LANE1"))
        #expect(NotificationPlan.laneAction(actionID: "x", laneName: "LANE1") == nil)
    }

    @Test func laneTransitionsFireOnceOnAchievedOrBlocked() {
        var achieved = roster.rows
        achieved[1].goalStatus?.state = "achieved"
        let t = Derived.laneTransitions(old: roster.rows, new: achieved)
        #expect(t.map(\.name) == ["LANE1"] && t.map(\.state) == ["achieved"])
        #expect(Derived.laneTransitions(old: achieved, new: achieved).isEmpty)
        var blocked = achieved
        blocked[1].goalStatus?.state = "blocked"
        #expect(Derived.laneTransitions(old: achieved, new: blocked).map(\.state) == ["blocked"])
        #expect(Derived.laneTransitions(old: roster.rows, new: roster.rows).isEmpty)
    }

    @Test func cardHelpers() {
        #expect(Derived.planText(roster.rows[1].goalStatus) == "2/5")
        #expect(Derived.planText(nil) == nil)
        #expect(Derived.budgetFraction(cost: 1.5, budget: 5) == 0.3)
        #expect(Derived.budgetFraction(cost: 9, budget: 5) == 1)
        #expect(Derived.budgetFraction(cost: 1, budget: nil) == nil)
        #expect(Derived.costText(nil) == "-")
        #expect(Derived.costText(1.234) == "$1.23")
        #expect(Derived.elapsedText(startedAtMs: Fixtures.noonMs - 3_900_000, now: Fixtures.noon) == "1h 5m")
    }
}

@MainActor
@Suite struct DeskStoreTests {
    @Test func applyMergesStreamItemsAndFiresHooks() throws {
        let store = DeskStore(client: APIClient(config: ServerConfig(port: 1)), clock: { Fixtures.noon })
        var opened: [String] = []
        var transitions: [String] = []
        var badge = -1
        store.onDecisionOpened = { opened.append($0.id) }
        store.onLaneTransition = { n, s in transitions.append("\(n):\(s)") }
        store.onDecisionsChanged = { badge = $0.count }

        let roster = try JSONDecoder().decode(RosterView.self, from: Fixtures.data(Fixtures.rosterView))
        store.apply(.roster(roster))
        #expect(store.decisionBadge == 1)
        #expect(opened == ["D1"])
        #expect(badge == 1)
        #expect(transitions.isEmpty) // first snapshot never notifies
        #expect(store.costToday == 0 || store.costToday == 1.5) // depends on the host timezone; Derived tests pin UTC

        // answer arrives over SSE -> badge drops, and a later roster copy of D1 cannot reopen it
        let answered = try JSONDecoder().decode(Decision.self, from: Fixtures.data(Fixtures.answeredDecision))
        store.apply(.decision(answered))
        #expect(store.decisionBadge == 0)
        #expect(badge == 0)
        store.apply(.roster(roster))
        #expect(store.decisionBadge == 0)
        #expect(opened == ["D1"]) // not re-notified

        // a lane reaching its goal notifies once
        var achieved = roster
        achieved.rows[1].goalStatus?.state = "achieved"
        store.apply(.roster(achieved))
        store.apply(.roster(achieved))
        #expect(transitions == ["LANE1:achieved"])

        // messages dedupe by id and sort by time
        let m = try JSONDecoder().decode(DeskMessage.self, from: Fixtures.data(Fixtures.message))
        store.apply(.message(m))
        store.apply(.message(m))
        #expect(store.messages.map(\.id) == ["m9"])

        // events dedupe by runId#seq; listener text drives the HUD
        let evs = try JSONDecoder().decode(EventsResponse.self, from: Fixtures.data(Fixtures.events)).events
        for e in evs + evs { store.apply(.event(e)) }
        #expect(store.eventsByDesk["LISTENER"]?.count == 6)
        #expect(store.listenerText == "Talking point A")
        #expect(store.liveCallDesks == ["LISTENER"])
        store.apply(.unknown("whatever"))
    }

    @Test func failedActionErrorSurvivesTheRefreshAfterIt() async throws {
        let server = try MockServer(handler: { r, i in
            if r.method == "POST" { return .json(500, #"{"error":"boom"}"#) }
            return desksHandler(r, i)
        })
        try await server.start()
        defer { server.stop() }
        let store = DeskStore(client: APIClient(config: ServerConfig(port: server.port)), clock: { Fixtures.noon })
        await store.stopLane("LANE1")
        #expect(server.requests.contains { $0.method == "GET" && $0.path == "/api/desks" }, "the refresh ran")
        #expect(store.lastError?.hasPrefix("stop LANE1:") == true, "the action error is still shown")
        await store.approve("L1")
        #expect(store.lastError?.hasPrefix("approve L1:") == true)
        await store.refreshAll()
        #expect(store.lastError == nil, "a later clean refresh clears it")
    }

    @Test func refreshAllLoadsListenerEventsSoHudAndLiveCallWorkAtLaunch() async throws {
        let server = try MockServer(handler: desksHandler)
        try await server.start()
        defer { server.stop() }
        let store = DeskStore(client: APIClient(config: ServerConfig(port: server.port)), clock: { Fixtures.noon })
        await store.refreshAll()
        #expect(server.requests.contains { $0.path == "/api/desks/LISTENER/events" })
        #expect(store.listenerText == "Talking point A")
        #expect(store.liveCallDesks == ["LISTENER"])
        #expect(store.engines.count == 3 && store.mcpNames.count == 3 && store.messages.count == 2)
    }
}


@Suite struct HelperPureTests {
    @Test func laneNameRejectsEveryTrailingLineTerminator() {
        for tail in ["\n", "\r\n", "\r", "\u{85}", "\u{2028}", "\u{2029}"] {
            #expect(!NewLaneBody.isValidName("lane1" + tail), "tail \(tail.unicodeScalars.map(\.value))")
        }
        #expect(NewLaneBody.isValidName("lane1"))
    }

    /// Same examples as tests/desks-roster.test.ts ("validName ... lane"), plus non-ASCII case folds:
    /// JS /i without the u flag never folds U+212A (Kelvin) or U+017F (long s) onto ASCII, and neither may ICU here.
    @Test func laneNameMatchesTheServerExamples() {
        for n in ["lane-1", "L1", "9x", String(repeating: "a", count: 48)] { #expect(NewLaneBody.isValidName(n), "\(n)") }
        for n in ["", "-a", "a b", String(repeating: "a", count: 49), "a/b"] { #expect(!NewLaneBody.isValidName(n), "\(n)") }
        for n in ["\u{212A}ane1", "\u{017F}ane", "lane\u{212A}", "hum\u{212A}n"] { #expect(!NewLaneBody.isValidName(n), "\(n.unicodeScalars.map(\.value))") }
    }

    @Test func suggestedNameSkipsNamesCaseInsensitively() {
        #expect(NewLaneBody.suggestedName(used: []) == "LANE1")
        #expect(NewLaneBody.suggestedName(used: ["lane1"]) == "LANE2")
        #expect(NewLaneBody.suggestedName(used: ["Lane1", "lane2", "LANE4"]) == "LANE3")
    }

    @Test func shellQuoteProtectsMetacharacters() {
        #expect(ShellQuote.command(["ach", "desk", "chat", "LANE1"]) == "ach desk chat LANE1")
        #expect(ShellQuote.command(["/Users/a b/ach", "desk"]) == "'/Users/a b/ach' desk")
        #expect(ShellQuote.word("it's") == "'it'\\''s'")
        #expect(ShellQuote.word("$(rm -rf ~)") == "'$(rm -rf ~)'")
        #expect(ShellQuote.word("") == "''")
    }
}

@MainActor
@Suite struct DeskStoreFixTests {
    @Test func stopClearsPollingSoStoppedStoreIsNotConnected() throws {
        let store = DeskStore(client: APIClient(config: ServerConfig(port: 1)), clock: { Fixtures.noon })
        let roster = try JSONDecoder().decode(RosterView.self, from: Fixtures.data(Fixtures.rosterView))
        store.apply(.roster(roster))
        store.streamStatusChanged(.disconnected(retryIn: 1, failures: 5))
        #expect(store.polling)
        #expect(store.isConnected)
        store.stop()
        #expect(!store.polling)
        #expect(!store.isConnected)
    }

    // MARK: reconfigure

    @MainActor @Test func reconfigureToAnotherServerClearsOldServerStateButSameServerKeepsIt() {
        let a = ServerConfig(port: 1, token: "ta")
        let roster = try! JSONDecoder().decode(RosterView.self, from: Fixtures.data(Fixtures.rosterView))
        let store = DeskStore(client: APIClient(config: a), clock: { Fixtures.noon })
        store.apply(.roster(roster))
        store.apply(.decision(Decision(id: "D9", question: "q", options: [], askedBy: "X", openedAt: 1, state: "open")))
        #expect(store.roster != nil)
        #expect(!store.decisions.isEmpty)
        store.reconfigure(ServerConfig(port: 1, token: "ta")) // same server
        #expect(store.roster != nil)
        #expect(!store.decisions.isEmpty)
        store.reconfigure(ServerConfig(port: 2, token: "ta")) // other port
        #expect(store.roster == nil)
        #expect(store.decisions.isEmpty)
        #expect(store.desks.isEmpty)
        store.apply(.roster(roster))
        store.reconfigure(ServerConfig(port: 2, token: "tb")) // token change only
        #expect(store.roster == nil)
    }

    // MARK: SSE retry honored

    @Test func reconnectDelayHonorsServerRetryOverBackoff() {
        let c = SSEStreamClient(request: { URLRequest(url: URL(string: "http://127.0.0.1:1")!) }, backoff: Backoff(base: 4, cap: 30))
        #expect(c.nextReconnectDelayForTesting() == 4) // no retry yet: backoff fallback
        c.ingestForTesting("retry: 2500\ndata: x\n\n")
        #expect(c.nextReconnectDelayForTesting() == 2.5)
        c.ingestForTesting("retry: +9\nretry: abc\n\n") // non-digit values ignored
        #expect(c.nextReconnectDelayForTesting() == 2.5)
        c.ingestForTesting("retry: 1000\n\n")
        #expect(c.nextReconnectDelayForTesting() == 1)
    }

    // MARK: invalid host does not crash

    @MainActor @Test func invalidHostSurfacesAsLastErrorInsteadOfCrashing() async throws {
        for host in ["bad host", "[::1", "a b/c"] {
            let cfg = ServerConfig(host: host, port: 1)
            let client = APIClient(config: cfg)
            #expect(throws: APIError.self) { try client.url("") }
            #expect(throws: APIError.self) { try client.streamRequest() }
            let store = DeskStore(client: client, clock: { Fixtures.noon })
            await store.refreshAll()
            #expect(store.lastError?.contains("invalid server address") == true)
        }
        #expect(ServerConfig(host: "127.0.0.1", port: 8399).baseURL?.absoluteString == "http://127.0.0.1:8399")
    }

    @Test func streamClientReportsRequestBuildFailureAndStops() async throws {
        let c = SSEStreamClient(request: { throw APIError.invalidServer("bad host:1") }, callbackQueue: DispatchQueue(label: "cb-bad"))
        let got = LockedBox<String?>(nil)
        c.onRequestError = { got.set($0) }
        c.start()
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(got.get()?.contains("bad host") == true)
    }

    // MARK: SSE last-event-id commits on dispatch only

    @Test func lastEventIDAdvancesOnlyWhenEventIsDispatched() {
        let c = SSEStreamClient(request: { URLRequest(url: URL(string: "http://127.0.0.1:1")!) })
        c.ingestForTesting("id: 5\ndata: a\n\n")
        #expect(c.lastEventIDForTesting() == "5")
        c.ingestForTesting("id: 6\ndata: b") // stream cut mid-event
        #expect(c.lastEventIDForTesting() == "5")
        c.ingestForTesting("\n\n")
        #expect(c.lastEventIDForTesting() == "6")
    }
}

@Suite(.serialized) struct StreamConnectingOrderTests {
    /// `.connecting` is reported before the task is resumed, so a fast open can never be followed by a late one.
    /// The hook stalls the connecting thread for 300 ms right after the resume; the open lands during the stall.
    @Test func connectingIsReportedBeforeConnectedEvenWhenTheOpenIsFast() async throws {
        let server = try MockServer { req, _ in
            guard req.path == "/api/desks/stream" else { return .json(404, "{}") }
            return .sse(chunks: [(0, ": open\n\n")], close: false)
        }
        try await server.start()
        defer { server.stop() }
        let client = APIClient(config: ServerConfig(port: server.port))
        let statuses = Box<StreamStatus>()
        let s = SSEStreamClient(request: { try client.streamRequest() }, callbackQueue: DispatchQueue(label: "cb-order"))
        s.afterResumeForTesting = { Thread.sleep(forTimeInterval: 0.3) }
        s.onStatus = { statuses.append($0) }
        s.start()
        defer { s.stop() }
        #expect(await eventually { statuses.items.contains(.connected) })
        let seen = statuses.items
        let k = seen.firstIndex(of: .connecting), c = seen.firstIndex(of: .connected)
        #expect(k != nil && c != nil && k! < c!, "expected connecting before connected, got \(seen)")
    }
}

private final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    func set(_ n: T) { lock.withLock { v = n } }
    func get() -> T { lock.withLock { v } }
}
