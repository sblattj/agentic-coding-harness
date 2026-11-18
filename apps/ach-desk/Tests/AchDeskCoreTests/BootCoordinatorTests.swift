import Foundation
import Testing
@testable import AchDeskCore

/// Lets a test finish a "boot" on cue.
private actor Gate {
    private var cont: CheckedContinuation<Void, Never>?
    private var opened = false
    func wait() async {
        if opened { return }
        await withCheckedContinuation { cont = $0 }
    }
    func open() { opened = true; cont?.resume(); cont = nil }
}

@MainActor @Suite struct BootCoordinatorTests {
    @Test func aBootFinishingAfterAReconnectDoesNotApply() async {
        let coord = BootCoordinator()
        let slow = Gate()
        var applied: [String] = []
        let first = coord.run({ await slow.wait(); return "old" }, apply: { applied.append($0) })
        let second = coord.run({ "new" }, apply: { applied.append($0) })
        await second.value
        await slow.open()
        await first.value
        #expect(applied == ["new"], "the stale boot must not apply; applied \(applied)")
    }

    @Test func invalidateDropsAnInFlightBoot() async {
        let coord = BootCoordinator()
        let slow = Gate()
        var applied: [String] = []
        let t = coord.run({ await slow.wait(); return "x" }, apply: { applied.append($0) })
        coord.invalidate()
        await slow.open()
        await t.value
        #expect(applied.isEmpty)
    }

    @Test func aLoneBootApplies() async {
        let coord = BootCoordinator()
        var applied: [String] = []
        await coord.run({ "only" }, apply: { applied.append($0) }).value
        #expect(applied == ["only"])
    }
}
