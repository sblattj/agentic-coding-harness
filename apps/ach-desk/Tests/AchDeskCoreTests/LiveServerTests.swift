import Foundation
import Testing
@testable import AchDeskCore

/// Opt-in acceptance against a real `ach web` with a desk stack up:
///   ACH_DESK_LIVE_PORT=<port> swift test --filter LiveServerTests
/// Mock fixtures cannot catch drift between Models.swift and the server, so every
/// read endpoint the app uses is decoded from the live server here, and one send
/// round-trips through the real host.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["ACH_DESK_LIVE_PORT"] != nil))
struct LiveServerTests {
    let client: APIClient = {
        let env = ProcessInfo.processInfo.environment
        let port = Int(env["ACH_DESK_LIVE_PORT"] ?? "") ?? 8399
        return APIClient(config: ServerConfig(port: port, token: env["AGENTIC_CODING_HARNESS_HTTP_TOKEN"]))
    }()

    @Test func everyReadEndpointDecodes() async throws {
        let view = try await client.roster()
        #expect(!view.rows.isEmpty, "start a stack first: ach desk up")
        _ = try await client.messages()
        _ = try await client.decisions()
        _ = try await client.costs()
        _ = try await client.engines()
        _ = try await client.mcps()
        let firstDesk = view.rows.filter { !$0.isLane }.first
        let desk = try #require(firstDesk)
        _ = try await client.events(desk: desk.name)
    }

    @Test func sendRoundTripsThroughTheHost() async throws {
        let view = try await client.roster()
        let firstDesk = view.rows.filter { !$0.isLane }.first
        let desk = try #require(firstDesk)
        let tag = "MACPROBE-\(Int(Date().timeIntervalSince1970 * 1000))"
        let sent = try await client.sendMessage(to: desk.name, text: "\(tag) (app live test, no reply needed)")
        #expect(sent.to == desk.name)
        let back = try await client.messages()
        #expect(back.contains { $0.text.contains(tag) })
    }
}
