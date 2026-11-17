import Foundation
import Testing
@testable import AchDeskCore

/// Routes a mock ach web the way types.ts documents it.
func desksHandler(_ r: RecordedRequest, _ i: Int) -> MockResponse {
    switch (r.method, r.path) {
    case ("GET", "/api/desks"): return .json(200, Fixtures.rosterView)
    case ("GET", "/api/desks/messages"): return .json(200, Fixtures.messages)
    case ("GET", "/api/desks/decisions"): return .json(200, Fixtures.decisions)
    case ("POST", "/api/desks/decisions/D1/answer"): return .json(200, Fixtures.answeredDecision)
    case ("POST", "/api/desks/send"): return .json(200, Fixtures.message)
    case ("POST", "/api/desks/up"): return .json(200, Fixtures.rosterView)
    case ("POST", "/api/desks/down"): return .json(200, #"{"stopped":["LISTENER","LANE1"]}"#)
    case ("POST", "/api/desks/lanes"):
        return r.jsonBody?["name"] as? String == "LANE4" ? .json(200, Fixtures.pendingResult) : .json(200, Fixtures.rosterEntry)
    case ("POST", "/api/desks/lanes/LANE1/stop"): return .json(200, "{}")
    case ("POST", "/api/desks/pending/L1/approve"): return .json(200, Fixtures.rosterEntry)
    case ("POST", "/api/desks/pending/L1/reject"):
        return .json(200, #"{"id":"L1","request":{"name":"LANE2","goal":"Refactor","launchedBy":"LISTENER"},"requestedAt":1,"state":"rejected","decidedBy":"human","reason":"no"}"#)
    case ("POST", "/api/desks/LISTENER/engine"): return .json(200, Fixtures.rosterEntry)
    case ("GET", "/api/desks/LISTENER/events"): return .json(200, Fixtures.events)
    case ("GET", "/api/desks/costs"): return .json(200, Fixtures.costs)
    case ("GET", "/api/desks/engines"): return .json(200, Fixtures.engines)
    case ("GET", "/api/desks/mcps"): return .json(200, Fixtures.mcps)
    default: return .json(404, #"{"error":"not found"}"#)
    }
}

@Suite(.serialized) struct APIClientTests {
    func withServer(token: String? = nil, _ body: (APIClient, MockServer) async throws -> Void) async throws {
        let server = try MockServer(handler: desksHandler)
        try await server.start()
        defer { server.stop() }
        let client = APIClient(config: ServerConfig(port: server.port, token: token))
        try await body(client, server)
    }

    @Test func postBodiesMatchTheDocumentedShapes() async throws {
        try await withServer { client, server in
            let m = try await client.sendMessage(to: "LISTENER", text: "hello")
            #expect(m.id == "m9")
            let d = try await client.answerDecision(id: "D1", text: "Ship it")
            #expect(d.state == "answered")
            let r = try await client.newLane(NewLaneBody(name: "LANE3", goal: "Write docs", mcps: ["gh", "whosaid"], cwd: "/tmp/w", agent: "claude", model: "claude-sonnet-5-5", budgetUsd: 2.5))
            #expect(r == .started(try JSONDecoder().decode(RosterEntry.self, from: Fixtures.data(Fixtures.rosterEntry))))
            let p = try await client.newLane(NewLaneBody(name: "LANE4", goal: "g"))
            if case .pending(let pl) = p { #expect(pl.id == "L2") } else { Issue.record("expected pending") }
            _ = try await client.setEngine(desk: "LISTENER", agent: "claude", model: nil)
            _ = try await client.rejectPending(id: "L1", reason: "no")
            _ = try await client.approvePending(id: "L1")
            try await client.stopLane(name: "LANE1")
            _ = try await client.up()
            let stopped = try await client.down()
            #expect(stopped == ["LISTENER", "LANE1"])

            let reqs = server.requests
            func body(_ path: String, _ n: Int = 0) -> NSDictionary? { reqs.filter { $0.path == path }[n].jsonBody }
            #expect(body("/api/desks/send") == ["to": "LISTENER", "text": "hello"] as NSDictionary)
            #expect(body("/api/desks/decisions/D1/answer") == ["text": "Ship it"] as NSDictionary)
            #expect(body("/api/desks/lanes") == [
                "name": "LANE3", "goal": "Write docs", "mcps": ["gh", "whosaid"], "cwd": "/tmp/w",
                "agent": "claude", "model": "claude-sonnet-5-5", "budgetUsd": 2.5,
            ] as NSDictionary)
            #expect(body("/api/desks/lanes", 1) == ["name": "LANE4", "goal": "g"] as NSDictionary)
            #expect(body("/api/desks/LISTENER/engine") == ["agent": "claude"] as NSDictionary)
            #expect(body("/api/desks/pending/L1/reject") == ["reason": "no"] as NSDictionary)
            #expect(body("/api/desks/up") == [:] as NSDictionary)
            for r in reqs where r.method == "POST" {
                #expect(r.headers["content-type"] == "application/json")
            }
            #expect(reqs.allSatisfy { $0.headers["authorization"] == nil && $0.query["token"] == nil })
        }
    }

    @Test func getsDecodeAndPassSince() async throws {
        try await withServer { client, server in
            let roster = try await client.roster()
            let messages = try await client.messages(since: 1763380300000)
            let events = try await client.events(desk: "LISTENER", since: 3)
            let costs = try await client.costs()
            let engines = try await client.engines()
            let mcps = try await client.mcps()
            let decisions = try await client.decisions()
            #expect(roster.rows.count == 3)
            #expect(messages.count == 2)
            #expect(events.count == 6)
            #expect(costs.count == 2)
            #expect(engines.count == 3)
            #expect(mcps == ["gh", "whosaid", "toolbox"])
            #expect(decisions.count == 2)
            let reqs = server.requests
            #expect(reqs.first { $0.path == "/api/desks/messages" }?.query["since"] == "1763380300000")
            #expect(reqs.first { $0.path == "/api/desks/LISTENER/events" }?.query["since"] == "3")
        }
    }

    @Test func tokenSentAsBearerAndQueryOnEveryRequest() async throws {
        try await withServer(token: "s3cret") { client, server in
            _ = try await client.roster()
            _ = try await client.sendMessage(to: "LISTENER", text: "x")
            _ = try await client.messages(since: 5)
            let reqs = server.requests
            #expect(reqs.count == 3)
            for r in reqs {
                #expect(r.headers["authorization"] == "Bearer s3cret")
                #expect(r.query["token"] == "s3cret")
            }
            #expect(reqs[2].query["since"] == "5")
            let s = client.streamRequest()
            #expect(s.value(forHTTPHeaderField: "Authorization") == "Bearer s3cret")
            #expect(s.url?.query?.contains("token=s3cret") == true)
            #expect(s.value(forHTTPHeaderField: "Accept") == "text/event-stream")
            #expect(s.url?.path == "/api/desks/stream")
        }
    }

    @Test func emptyTokenMeansNoToken() {
        #expect(ServerConfig(port: 1, token: "").token == nil)
    }

    @Test func httpErrorsSurfaceStatus() async throws {
        let server = try MockServer { _, _ in .json(401, #"{"error":"unauthorized"}"#) }
        try await server.start()
        defer { server.stop() }
        let client = APIClient(config: ServerConfig(port: server.port))
        do {
            _ = try await client.roster()
            Issue.record("expected an error")
        } catch let e as APIError {
            if case .http(let status, _) = e { #expect(status == 401) } else { Issue.record("wrong error \(e)") }
        }
    }
}
