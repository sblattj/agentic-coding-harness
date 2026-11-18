import Foundation
import Testing
@testable import AchDeskCore

@Suite(.serialized) struct StaleServerFenceTests {
    /// An old server that answers every desks route, but only after `delay`.
    func slowServer(_ delay: TimeInterval = 0.6) throws -> MockServer {
        try MockServer { r, i in
            switch desksHandler(r, i) {
            case .json(let s, let b): return .jsonAfter(delay, s, b)
            case let other: return other
            }
        }
    }

    /// Start `refresh` against the old server, reconfigure to another server while it is in flight,
    /// let it finish, and return the store for the caller to assert it stayed empty.
    @MainActor func refreshAcrossReconfigure(_ refresh: @escaping @MainActor (DeskStore) async -> Void) async throws -> DeskStore {
        let old = try slowServer()
        try await old.start()
        defer { old.stop() }
        let store = DeskStore(client: APIClient(config: ServerConfig(port: old.port)), clock: { Fixtures.noon })
        let inFlight = Task { await refresh(store) }
        #expect(await eventually { !old.requests.isEmpty }, "the refresh reached the old server")
        store.reconfigure(ServerConfig(port: 1))
        await inFlight.value
        return store
    }

    @MainActor @Test func refreshAllFromThePreviousServerIsDropped() async throws {
        let store = try await refreshAcrossReconfigure { await $0.refreshAll() }
        #expect(store.roster == nil && store.decisions.isEmpty && store.messages.isEmpty)
        #expect(store.engines.isEmpty && store.mcpNames.isEmpty && store.costs.isEmpty && store.eventsByDesk.isEmpty)
        #expect(store.lastError == nil)
    }

    @MainActor @Test func refreshCoreFromThePreviousServerIsDropped() async throws {
        let store = try await refreshAcrossReconfigure { await $0.refreshCore() }
        #expect(store.roster == nil && store.decisions.isEmpty && store.messages.isEmpty)
    }

    @MainActor @Test func refreshCostsFromThePreviousServerIsDropped() async throws {
        let store = try await refreshAcrossReconfigure { await $0.refreshCosts() }
        #expect(store.costs.isEmpty)
    }

    @MainActor @Test func loadEventsFromThePreviousServerIsDropped() async throws {
        let store = try await refreshAcrossReconfigure { await $0.loadEvents(desk: "LISTENER") }
        #expect(store.eventsByDesk.isEmpty)
    }

    @MainActor @Test func refreshAfterReconfigureStillWorks() async throws {
        let fast = try MockServer(handler: desksHandler)
        try await fast.start()
        defer { fast.stop() }
        let store = DeskStore(client: APIClient(config: ServerConfig(port: 1)), clock: { Fixtures.noon })
        store.reconfigure(ServerConfig(port: fast.port))
        await store.refreshAll()
        #expect(store.roster != nil && !store.costs.isEmpty)
    }
}
