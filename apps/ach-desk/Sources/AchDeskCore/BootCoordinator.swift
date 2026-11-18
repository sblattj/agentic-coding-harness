// Runs one backend boot at a time from the app's point of view: a boot that finishes after a
// newer boot started (reconfigure / restart) or after `invalidate()` must not apply its result.
import Foundation

@MainActor
public final class BootCoordinator {
    private var generation = 0

    public init() {}

    /// Start `work`, then `apply` its result on the main actor only if no newer `run` or `invalidate` happened meanwhile.
    @discardableResult
    public func run<T: Sendable>(_ work: @escaping @Sendable () async -> T, apply: @escaping @MainActor (T) async -> Void) -> Task<Void, Never> {
        generation += 1
        let mine = generation
        return Task { @MainActor [weak self] in
            let result = await work()
            guard let self, self.generation == mine else { return }
            await apply(result)
        }
    }

    /// Drop every boot still in flight (shutdown).
    public func invalidate() { generation += 1 }
}
