import Foundation
import Testing
@testable import AchDeskCore

@Suite struct DecodingTests {
    let dec = JSONDecoder()

    @Test func offDeskRowDecodesAndIsNotAlive() throws {
        let json = """
        {"name": "LISTENER", "kind": "desk", "role": "listener", "agent": "opencode", "engine": "opencode",
         "mcps": [], "port": 4802, "url": "http://127.0.0.1:4802", "pid": 1, "runId": "run-l",
         "cwd": "/tmp", "startedAt": 1763290000000, "off": {"at": 1763380000000, "by": "human"},
         "achVersion": "0.31.0", "state": "off", "queueDepth": 0, "costUsd": 0.5, "treeCostUsd": 0.5}
        """
        let row = try dec.decode(RosterRow.self, from: Data(json.utf8))
        #expect(row.state == "off")
        #expect(row.isOff)
        #expect(!row.isAlive)
        #expect(row.entry.terminal == nil)
    }

    @Test func rosterViewDecodesDeskLanePendingAndDecision() throws {
        let v = try dec.decode(RosterView.self, from: Fixtures.data(Fixtures.rosterView))
        #expect(v.version == desksAPIVersion)
        #expect(v.stack == "default")
        #expect(v.portBase == 4800)
        #expect(v.me == "human")
        #expect(v.rows.count == 3)
        #expect(v.desks.map(\.name) == ["LISTENER"])
        #expect(v.lanes.map(\.name) == ["LANE1", "LANE0"])

        let desk = v.rows[0]
        #expect(desk.entry.feedPid == 2002)
        #expect(desk.entry.terminal == TerminalRef(kind: "tmux", id: "%15"))
        #expect(desk.entry.engineUrl == "http://127.0.0.1:5301")
        #expect(desk.state == "busy")
        #expect(desk.queueDepth == 2)
        #expect(desk.treeCostUsd == 1.92)

        let lane = v.rows[1]
        #expect(lane.entry.parentRunId == "run-listener")
        #expect(lane.entry.budgetUsd == 5)
        #expect(lane.goalStatus?.plan == GoalPlan(verified: 2, total: 5))
        #expect(lane.goalStatus?.state == "active")
        #expect(lane.entry.model == nil) // optional field absent

        let dead = v.rows[2]
        #expect(dead.costUsd == nil) // explicit JSON null
        #expect(dead.treeCostUsd == nil)
        #expect(!dead.isAlive)

        #expect(v.pendingLanes.count == 1)
        #expect(v.pendingLanes[0].request.mcps == ["gh"])
        #expect(v.pendingLanes[0].request.cwd == nil)

        let d = try #require(v.openDecisions.first)
        #expect(d.id == "D1")
        #expect(d.options.count == 4)
        #expect(d.orderedOptions.first?.label == "Ship it")
        #expect(d.orderedOptions.first?.reason == "tests are green")
        #expect(d.answer == nil)
    }

    @Test func messagesEventsCostsEnginesMcps() throws {
        let m = try dec.decode(MessagesResponse.self, from: Fixtures.data(Fixtures.messages)).messages
        #expect(m.map(\.id) == ["m1", "m2"])
        #expect(m[1].text == "line one\nline two")
        #expect(m[1].delivered == "queued")

        let e = try dec.decode(EventsResponse.self, from: Fixtures.data(Fixtures.events)).events
        #expect(e.count == 6)
        #expect(e[1].displayText == "Talking point A")
        #expect(e[2].displayText == "whosaid: search")
        #expect(e[3].data["costUsd"]?.doubleValue == 0.01)
        #expect(e[3].displayText == nil)
        #expect(e[4].type == "brand_new_type") // unknown event type tolerated
        #expect(e[5].displayText == "goal: achieved")
        #expect(e[0].id == "run-listener#1")

        let c = try dec.decode(CostsResponse.self, from: Fixtures.data(Fixtures.costs)).rows
        #expect(c.count == 2)
        #expect(c[0].lanes.first?.name == "LANE1")
        #expect(c[1].costUsd == nil)

        let en = try dec.decode(EnginesResponse.self, from: Fixtures.data(Fixtures.engines)).engines
        #expect(en.map(\.agent) == ["opencode", "claude", "kiro"])
        #expect(en[1].auth == nil)
        #expect(en[2].path == nil && !en[2].found)

        #expect(try dec.decode(McpsResponse.self, from: Fixtures.data(Fixtures.mcps)).names == ["gh", "whosaid", "toolbox"])

        let ds = try dec.decode(DecisionsResponse.self, from: Fixtures.data(Fixtures.decisions)).decisions
        #expect(ds[0].answer?.by == "human")
        #expect(ds[1].options.isEmpty)
    }

    @Test func laneCreateResultUnion() throws {
        let started = try dec.decode(LaneCreateResult.self, from: Fixtures.data(Fixtures.rosterEntry))
        guard case .started(let e) = started else { Issue.record("expected started"); return }
        #expect(e.name == "LANE3")
        let pending = try dec.decode(LaneCreateResult.self, from: Fixtures.data(Fixtures.pendingResult))
        guard case .pending(let p) = pending else { Issue.record("expected pending"); return }
        #expect(p.id == "L2")
    }

    @Test func streamItemsDecodeAndUnknownKindIgnored() throws {
        let msg = try StreamItem.decode(Fixtures.data(#"{"kind":"message","message":\#(Fixtures.message)}"#))
        guard case .message(let m) = msg else { Issue.record("message"); return }
        #expect(m.id == "m9")
        let ev = try StreamItem.decode(Fixtures.data(#"{"kind":"event","event":{"seq":7,"at":1,"runId":"r","name":"LISTENER","type":"text","data":{"text":"x"}}}"#))
        guard case .event(let e) = ev else { Issue.record("event"); return }
        #expect(e.seq == 7)
        let ros = try StreamItem.decode(Fixtures.data(#"{"kind":"roster","view":\#(Fixtures.rosterView)}"#))
        guard case .roster(let v) = ros else { Issue.record("roster"); return }
        #expect(v.rows.count == 3)
        let d = try StreamItem.decode(Fixtures.data(#"{"kind":"decision","decision":\#(Fixtures.answeredDecision)}"#))
        guard case .decision(let dd) = d else { Issue.record("decision"); return }
        #expect(dd.state == "answered")
        #expect(try StreamItem.decode(Fixtures.data(#"{"kind":"telemetry","x":1}"#)) == .unknown("telemetry"))
    }

    @Test func minimalObjectsWithOnlyRequiredFields() throws {
        let v = try dec.decode(RosterView.self, from: Fixtures.data(#"{"version":"desks-api/1","stack":"p4900","portBase":4900,"rows":[],"pendingLanes":[],"openDecisions":[]}"#))
        #expect(v.me == nil && v.rows.isEmpty)
        let ev = try dec.decode(HostEvent.self, from: Fixtures.data(#"{"seq":1,"at":2,"runId":"r","name":"N","type":"turn_start","data":{}}"#))
        #expect(ev.data.isEmpty)
    }

    @Test func requestBodiesOmitNilOptionals() throws {
        let enc = JSONEncoder()
        let lane = try JSONSerialization.jsonObject(with: enc.encode(NewLaneBody(name: "LANE5", goal: "g"))) as? NSDictionary
        #expect(lane == ["name": "LANE5", "goal": "g"] as NSDictionary)
        let eng = try JSONSerialization.jsonObject(with: enc.encode(EngineBody(agent: "claude"))) as? NSDictionary
        #expect(eng == ["agent": "claude"] as NSDictionary)
        let up = try JSONSerialization.jsonObject(with: enc.encode(UpBody())) as? NSDictionary
        #expect(up == [:] as NSDictionary)
    }

    @Test func laneNameRule() {
        #expect(NewLaneBody.isValidName("LANE1"))
        #expect(NewLaneBody.isValidName("A_B-9"))
        // Mirrors src/desks/roster.ts validName(lane): /^[a-z0-9][a-z0-9_-]{0,47}$/i, plus the reserved "human".
        #expect(NewLaneBody.isValidName("lane1"))
        #expect(NewLaneBody.isValidName("fix-login-timeout"))
        #expect(NewLaneBody.isValidName("probe-d2"))
        #expect(NewLaneBody.isValidName("1LANE"))
        #expect(NewLaneBody.isValidName("a" + String(repeating: "b", count: 47)))
        #expect(!NewLaneBody.isValidName("a" + String(repeating: "b", count: 48)))
        #expect(!NewLaneBody.isValidName("-lane"))
        #expect(!NewLaneBody.isValidName("_lane"))
        #expect(!NewLaneBody.isValidName("la ne"))
        #expect(!NewLaneBody.isValidName("lane\n"))
        #expect(!NewLaneBody.isValidName("human"))
        #expect(!NewLaneBody.isValidName("Human"))
        #expect(NewLaneBody.isValidName("humans"))
        #expect(!NewLaneBody.isValidName(""))
    }
}
