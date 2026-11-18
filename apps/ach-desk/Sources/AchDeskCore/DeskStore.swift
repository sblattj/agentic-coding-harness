// App state: one store fed by the SSE stream (with a 2 s polling fallback) and the REST routes.
import Foundation
import Combine

@MainActor
public final class DeskStore: ObservableObject {
    @Published public private(set) var roster: RosterView?
    @Published public private(set) var messages: [DeskMessage] = []
    @Published public private(set) var decisions: [Decision] = []
    @Published public private(set) var eventsByDesk: [String: [HostEvent]] = [:]
    @Published public private(set) var costs: [DeskCostRow] = []
    @Published public private(set) var engines: [EngineInfo] = []
    @Published public private(set) var mcpNames: [String] = []
    @Published public private(set) var streamStatus: StreamStatus = .stopped
    @Published public private(set) var polling = false
    @Published public var lastError: String?
    @Published public var backendNote: String = ""
    @Published public private(set) var now = Date()

    public private(set) var client: APIClient
    public var clock: () -> Date

    /// Hooks the app target wires to notifications / Dock badge.
    public var onDecisionOpened: ((Decision) -> Void)?
    public var onLaneTransition: ((String, String) -> Void)?
    public var onDecisionsChanged: (([Decision]) -> Void)?

    public static let maxEventsPerDesk = 500
    private var stream: SSEStreamClient?
    private var pollTimer: Timer?
    private var clockTimer: Timer?
    private var seenDecisionIDs = Set<String>()
    private var hadRoster = false
    /// Bumped by `reconfigure` when the server changes. Every async refresh or action captures it at the
    /// start and drops its result if it moved, so a response from the previous server never lands in state.
    private var serverEpoch = 0

    public init(client: APIClient, clock: @escaping () -> Date = Date.init) {
        self.client = client
        self.clock = clock
    }

    // MARK: derived

    public var desks: [RosterRow] { roster?.desks ?? [] }
    public var lanes: [RosterRow] { roster?.lanes ?? [] }
    public var pendingLanes: [PendingLane] { (roster?.pendingLanes ?? []).filter { $0.state == "pending" } }
    public var openDecisions: [Decision] { Derived.openDecisions(roster: roster, decisions: decisions) }
    public var decisionBadge: Int { Derived.decisionBadgeCount(roster: roster, decisions: decisions) }
    public var costToday: Double { Derived.lanesCostToday(rows: roster?.rows ?? [], now: now) }
    public var runningLanes: [RosterRow] { Derived.runningLanes(rows: roster?.rows ?? []) }
    public var liveCallDesks: [String] { Derived.liveCallDesks(rows: roster?.rows ?? [], eventsByDesk: eventsByDesk, now: now) }
    public var listenerName: String? { Derived.listenerName(rows: roster?.rows ?? []) }
    public var listenerText: String? { listenerName.flatMap { Derived.latestText(events: eventsByDesk[$0] ?? []) } }
    public var isConnected: Bool { streamStatus == .connected || (polling && roster != nil) }

    // MARK: lifecycle

    public func reconfigure(_ config: ServerConfig) {
        // Same server (host, port, token): keep everything.
        guard config != client.config else { return }
        stop()
        serverEpoch += 1
        client = APIClient(config: config)
        roster = nil
        messages = []
        decisions = []
        eventsByDesk = [:]
        costs = []
        engines = []
        mcpNames = []
        lastError = nil
        hadRoster = false
        seenDecisionIDs = []
    }

    public func start() {
        stop()
        let c = client
        let s = SSEStreamClient(request: { try c.streamRequest() })
        s.onRequestError = { [weak self] msg in MainActor.assumeIsolated { self?.lastError = msg } }
        s.onItem = { [weak self] item in MainActor.assumeIsolated { self?.apply(item) } }
        s.onStatus = { [weak self] st in MainActor.assumeIsolated { self?.streamStatusChanged(st) } }
        stream = s
        s.start()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pollTick() }
        }
        clockTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.now = self?.clock() ?? Date() }
        }
        Task { await refreshAll() }
    }

    public func stop() {
        stream?.stop()
        stream = nil
        pollTimer?.invalidate()
        pollTimer = nil
        clockTimer?.invalidate()
        clockTimer = nil
        polling = false
        streamStatus = .stopped
    }

    func streamStatusChanged(_ st: StreamStatus) {
        let wasConnected = streamStatus == .connected
        streamStatus = st
        if case .disconnected(_, let failures) = st { polling = failures >= Backoff.pollingThreshold }
        if st == .connected {
            polling = false
            if !wasConnected { Task { await refreshAll() } } // catch up on what the gap missed
        }
    }

    /// Every 2 s while the stream is down: poll roster, messages since the newest, decisions, listener events.
    func pollTick() {
        guard streamStatus != .connected, streamStatus != .stopped else { return }
        Task {
            await refreshCore()
            if let l = listenerName { await loadEvents(desk: l) }
        }
    }

    public func refreshAll() async {
        await refreshCore()
        let epoch = serverEpoch
        let client = client
        async let e = try? client.engines()
        async let m = try? client.mcps()
        async let c = try? client.costs()
        let (ev, mv, cv) = (await e, await m, await c)
        guard epoch == serverEpoch else { return }
        if let v = ev { engines = v }
        if let v = mv { mcpNames = v }
        if let v = cv { costs = v }
        for d in desks where d.entry.feedPid != nil || d.name == listenerName {
            guard epoch == serverEpoch else { return }
            await loadEvents(desk: d.name)
        }
    }

    func refreshCore() async {
        now = clock()
        let epoch = serverEpoch
        let client = client
        do {
            let v = try await client.roster()
            guard epoch == serverEpoch else { return }
            applyRoster(v)
            lastError = nil
        } catch {
            guard epoch == serverEpoch else { return }
            lastError = "\(error)"
            return
        }
        let msgs = try? await client.messages(since: messages.last?.at)
        guard epoch == serverEpoch else { return }
        if let msgs { mergeMessages(msgs) }
        let ds = try? await client.decisions()
        guard epoch == serverEpoch else { return }
        if let ds { mergeDecisions(ds) }
    }

    public func loadEvents(desk: String) async {
        // seq is per host run; after an engine restart (new runId) start that run's events from the top.
        let epoch = serverEpoch
        let client = client
        let runId = roster?.rows.first { $0.name == desk }?.entry.runId
        let since = eventsByDesk[desk]?.filter { runId == nil || $0.runId == runId }.map(\.seq).max()
        let evs = try? await client.events(desk: desk, since: since)
        guard epoch == serverEpoch else { return }
        if let evs { mergeEvents(evs, desk: desk) }
    }

    // MARK: applying updates

    public func apply(_ item: StreamItem) {
        now = clock()
        switch item {
        case .message(let m): mergeMessages([m])
        case .roster(let v): applyRoster(v)
        case .event(let e): mergeEvents([e], desk: e.name)
        case .decision(let d): mergeDecisions([d])
        case .unknown: break
        }
    }

    func applyRoster(_ v: RosterView) {
        let old = roster?.rows ?? []
        roster = v
        if hadRoster {
            for t in Derived.laneTransitions(old: old, new: v.rows) { onLaneTransition?(t.name, t.state) }
        }
        hadRoster = true
        mergeDecisions(v.openDecisions, fromRoster: true)
    }

    func mergeMessages(_ msgs: [DeskMessage]) {
        guard !msgs.isEmpty else { return }
        var byID = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for m in msgs { byID[m.id] = m }
        messages = byID.values.sorted { ($0.at, $0.id) < ($1.at, $1.id) }
    }

    func mergeDecisions(_ ds: [Decision], fromRoster: Bool = false) {
        var byID = Dictionary(decisions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for d in ds {
            // The roster's copy is only "open"; never let it reopen one we know is answered.
            if fromRoster, let known = byID[d.id], !known.isOpen { continue }
            byID[d.id] = d
        }
        decisions = byID.values.sorted { ($0.openedAt, $0.id) < ($1.openedAt, $1.id) }
        for d in decisions where d.isOpen && !seenDecisionIDs.contains(d.id) {
            seenDecisionIDs.insert(d.id)
            onDecisionOpened?(d)
        }
        onDecisionsChanged?(openDecisions)
    }

    func mergeEvents(_ evs: [HostEvent], desk: String) {
        guard !evs.isEmpty else { return }
        var list = eventsByDesk[desk] ?? []
        var ids = Set(list.map(\.id))
        for e in evs where !ids.contains(e.id) {
            list.append(e)
            ids.insert(e.id)
        }
        list.sort { ($0.at, $0.seq) < ($1.at, $1.seq) }
        if list.count > Self.maxEventsPerDesk { list.removeFirst(list.count - Self.maxEventsPerDesk) }
        eventsByDesk[desk] = list
    }

    // MARK: actions

    @discardableResult
    private func run(_ what: String, _ op: @escaping () async throws -> Void) async -> String? {
        let epoch = serverEpoch
        do {
            try await op()
            if epoch == serverEpoch { lastError = nil }
            return nil
        } catch {
            let msg = "\(what): \(error)"
            if epoch == serverEpoch { lastError = msg }
            return msg
        }
    }

    /// Run an action, then refresh. A successful refresh clears `lastError`, so a failed
    /// action's error is put back afterwards: the user must still see why it failed.
    private func runThenRefresh(_ what: String, _ op: @escaping () async throws -> Void) async {
        let epoch = serverEpoch
        let failure = await run(what, op)
        await refreshCore()
        if let failure, epoch == serverEpoch { lastError = failure }
    }

    public func send(to: String, text: String) async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let epoch = serverEpoch
        await run("send") { [self] in
            let m = try await client.sendMessage(to: to, text: t)
            if epoch == serverEpoch { mergeMessages([m]) }
        }
    }

    public func answer(decisionID: String, text: String) async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let epoch = serverEpoch
        await run("answer") { [self] in
            let d = try await client.answerDecision(id: decisionID, text: t)
            if epoch == serverEpoch { mergeDecisions([d]) }
        }
    }

    public func newLane(_ body: NewLaneBody) async -> LaneCreateResult? {
        var result: LaneCreateResult?
        await runThenRefresh("new lane") { [self] in result = try await client.newLane(body) }
        return result
    }

    public func stopLane(_ name: String) async {
        await runThenRefresh("stop \(name)") { [self] in try await client.stopLane(name: name) }
    }

    public func approve(_ id: String) async {
        await runThenRefresh("approve \(id)") { [self] in _ = try await client.approvePending(id: id) }
    }

    public func reject(_ id: String, reason: String?) async {
        await runThenRefresh("reject \(id)") { [self] in _ = try await client.rejectPending(id: id, reason: reason) }
    }

    public func up(layoutFile: String? = nil) async {
        let epoch = serverEpoch
        await run("start stack") { [self] in
            let v = try await client.up(layoutFile: layoutFile)
            if epoch == serverEpoch { applyRoster(v) }
        }
    }

    public func down() async {
        await runThenRefresh("stop stack") { [self] in _ = try await client.down() }
    }

    public func setEngine(desk: String, agent: String, model: String?) async {
        await runThenRefresh("engine \(desk)") { [self] in _ = try await client.setEngine(desk: desk, agent: agent, model: model) }
    }

    public func refreshCosts() async {
        let epoch = serverEpoch
        let c = try? await client.costs()
        guard epoch == serverEpoch else { return }
        if let c { costs = c }
    }
}
