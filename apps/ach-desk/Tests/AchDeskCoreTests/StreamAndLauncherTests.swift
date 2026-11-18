import Foundation
import Testing
@testable import AchDeskCore

final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _items: [T] = []
    func append(_ t: T) { lock.withLock { _items.append(t) } }
    var items: [T] { lock.withLock { _items } }
}

@Suite(.serialized) struct StreamClientTests {
    @Test func streamsSplitChunksThenReconnectsWithLastEventID() async throws {
        let msg = #"{"kind":"message","message":\#(Fixtures.message)}"#
        let evt = #"{"kind":"event","event":{"seq":2,"at":5,"runId":"r","name":"LISTENER","type":"text","data":{"text":"TP"}}}"#
        let server = try MockServer { req, i in
            guard req.path == "/api/desks/stream" else { return .json(404, "{}") }
            if i == 0 {
                // first connection: an event split mid-JSON, a comment, then the server drops us
                let half = msg.index(msg.startIndex, offsetBy: 20)
                return .sse(chunks: [(0.02, ": hello\n\nid: 1\ndata: " + msg[..<half]), (0.05, String(msg[half...]) + "\n\n"),
                                     (0.02, "data: {\"kind\":\"futurekind\"}\n\n")], close: true)
            }
            return .sse(chunks: [(0.02, "id: 2\ndata: \(evt)\n\n")], close: false)
        }
        try await server.start()
        defer { server.stop() }
        let client = APIClient(config: ServerConfig(port: server.port, token: "tok"))
        let items = Box<StreamItem>()
        let statuses = Box<StreamStatus>()
        let s = SSEStreamClient(request: { try client.streamRequest() }, backoff: Backoff(base: 0.05, cap: 0.2), callbackQueue: DispatchQueue(label: "cb"))
        s.onItem = { items.append($0) }
        s.onStatus = { statuses.append($0) }
        s.start()
        defer { s.stop() }

        #expect(await eventually(timeout: 15) { items.items.count >= 3 })
        let got = items.items
        try #require(got.count >= 3, "expected message, futurekind, event; got \(got)") // report, never crash on got[2]
        if case .message(let m) = got[0] { #expect(m.id == "m9") } else { Issue.record("first item should be the message: \(got)") }
        #expect(got[1] == .unknown("futurekind"))
        if case .event(let e) = got[2] { #expect(e.data["text"]?.stringValue == "TP") } else { Issue.record("third item should be the event") }

        let streamReqs = server.requests.filter { $0.path == "/api/desks/stream" }
        try #require(streamReqs.count >= 2)
        #expect(streamReqs[1].headers["last-event-id"] == "1")
        #expect(streamReqs.allSatisfy { $0.headers["authorization"] == "Bearer tok" && $0.query["token"] == "tok" })
        #expect(streamReqs[0].headers["accept"] == "text/event-stream")
        let st = statuses.items
        #expect(st.contains(.connected))
        #expect(st.contains { if case .disconnected = $0 { return true }; return false })
    }

    @Test func nonSSEResponseCountsAsFailureAndBacksOff() async throws {
        let server = try MockServer { _, _ in .json(404, #"{"error":"no desks api"}"#) }
        try await server.start()
        defer { server.stop() }
        let client = APIClient(config: ServerConfig(port: server.port))
        let statuses = Box<StreamStatus>()
        let s = SSEStreamClient(request: { try client.streamRequest() }, backoff: Backoff(base: 0.02, cap: 0.05), callbackQueue: DispatchQueue(label: "cb2"))
        s.onStatus = { statuses.append($0) }
        s.start()
        #expect(await eventually { s.failures >= Backoff.pollingThreshold })
        s.stop()
        #expect(!statuses.items.contains(.connected))
        let fails = statuses.items.compactMap { st -> Int? in if case .disconnected(_, let f) = st { return f }; return nil }
        #expect(fails.contains(Backoff.pollingThreshold)) // the store switches to 2 s polling here
    }

    /// A late response or chunk from a task a reconnect replaced must not reset the backoff, report .connected,
    /// or emit items. MockServer cannot make URLSession deliver an old task's callback after a reconnect on cue,
    /// so the live stream supplies the current task and a never-resumed task from a throwaway session plays the stale one.
    @Test func staleTaskResponseAndDataAreIgnored() async throws {
        let server = try MockServer { req, _ in
            guard req.path == "/api/desks/stream" else { return .json(404, "{}") }
            return .sse(chunks: [(0.01, ": open\n\n")], close: false)
        }
        try await server.start()
        defer { server.stop() }
        let client = APIClient(config: ServerConfig(port: server.port))
        let cbq = DispatchQueue(label: "cb3")
        let items = Box<StreamItem>()
        let statuses = Box<StreamStatus>()
        let s = SSEStreamClient(request: { try client.streamRequest() }, backoff: Backoff(base: 5, cap: 5), callbackQueue: cbq)
        s.onItem = { items.append($0) }
        s.onStatus = { statuses.append($0) }
        s.start()
        defer { s.stop() }
        #expect(await eventually { statuses.items.contains(.connected) })
        _ = s.nextReconnectDelayForTesting() // one counted failure, as after a dropped connection
        try #require(s.failures == 1)
        let connectedBefore = statuses.items.filter { $0 == .connected }.count

        let otherSession = URLSession(configuration: .ephemeral)
        defer { otherSession.invalidateAndCancel() }
        let stale = otherSession.dataTask(with: try client.streamRequest())
        let ok = HTTPURLResponse(url: stale.originalRequest!.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!
        let disposition = Box<URLSession.ResponseDisposition>()
        s.urlSession(otherSession, dataTask: stale, didReceive: ok) { disposition.append($0) }
        s.urlSession(otherSession, dataTask: stale, didReceive: Data("data: {\"kind\":\"futurekind\"}\n\n".utf8))
        cbq.sync {} // drain callbacks queued so far

        #expect(disposition.items == [.cancel])
        #expect(s.failures == 1)
        #expect(statuses.items.filter { $0 == .connected }.count == connectedBefore)
        #expect(items.items.isEmpty)
    }
}

@Suite(.serialized) struct LauncherTests {
    @Test func probeServingOccupiedAndNotRunning() async throws {
        let ok = try MockServer(handler: desksHandler)
        try await ok.start()
        if case .serving(let v) = await BackendLauncher.probe(APIClient(config: ServerConfig(port: ok.port))) {
            #expect(v.stack == "default")
        } else { Issue.record("expected serving") }
        let freePort = ok.port
        ok.stop()

        let auth = try MockServer { _, _ in .json(401, "unauthorized") }
        try await auth.start()
        defer { auth.stop() }
        #expect(await BackendLauncher.probe(APIClient(config: ServerConfig(port: auth.port))) == .occupied(status: 401, detail: "unauthorized"))

        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await BackendLauncher.probe(APIClient(config: ServerConfig(port: freePort))) == .notRunning)
    }

    @Test func commandVParsingSkipsNoiseAndAliases() {
        let l = BackendLauncher(isExecutable: { $0 == "/opt/homebrew/bin/ach" }, runCapture: { _, _ in nil })
        #expect(l.parseCommandV("welcome banner\n/opt/homebrew/bin/ach\n") == "/opt/homebrew/bin/ach")
        #expect(l.parseCommandV("alias ach='bunx ach'") == nil)
        #expect(l.parseCommandV("/not/executable/ach") == nil)
    }

    @Test func resolveOrderSettingsThenLoginShellThenBundled() {
        let calls = Box<[String]>()
        let all = BackendLauncher(isExecutable: { _ in true }, runCapture: { p, a in calls.append([p] + a); return "/usr/local/bin/ach\n" })
        #expect(all.resolveAch(settingsPath: "/custom/ach", bundledPath: "/App/ach") == .settings("/custom/ach"))
        #expect(calls.items.isEmpty) // Settings path wins without spawning a shell
        #expect(all.resolveAch(settingsPath: "", bundledPath: "/App/ach") == .loginShell("/usr/local/bin/ach"))
        #expect(calls.items.last == ["/bin/zsh", "-lc", "command -v ach"])
        let noShell = BackendLauncher(isExecutable: { $0 == "/App/ach" }, runCapture: { _, _ in nil })
        #expect(noShell.resolveAch(settingsPath: "/missing", bundledPath: "/App/ach") == .bundled("/App/ach"))
        let none = BackendLauncher(isExecutable: { _ in false }, runCapture: { _, _ in nil })
        #expect(none.resolveAch(settingsPath: nil, bundledPath: nil) == nil)
    }

    @Test func childArgsAndEnvironment() {
        #expect(BackendLauncher.webArguments(port: 8400) == ["web", "--port", "8400", "--no-open"])
        let env = BackendLauncher.childEnvironment(base: ["HOME": "/h", "AGENTIC_CODING_HARNESS_HTTP_TOKEN": "old"], path: "/a:/b", token: "", stateDir: "/s")
        #expect(env["PATH"] == "/a:/b")
        #expect(env["AGENTIC_CODING_HARNESS_HTTP_TOKEN"] == nil)
        #expect(env["AGENTIC_CODING_HARNESS_STATE_DIR"] == "/s")
        #expect(env["HOME"] == "/h")
        let env2 = BackendLauncher.childEnvironment(base: [:], path: "/a", token: "t", stateDir: nil)
        #expect(env2["AGENTIC_CODING_HARNESS_HTTP_TOKEN"] == "t")
        #expect(env2["AGENTIC_CODING_HARNESS_STATE_DIR"] == nil)
    }

    /// #212 review: `ach web` without --token keeps a generated token in <stateDir>/web/token and
    /// 401s without it; an app with an empty Settings token must read that file to connect.
    @Test func bootWithEmptySettingsTokenUsesTheStoredWebToken() async throws {
        let state = FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-token-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: state.appendingPathComponent("web"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: state) }
        let stored = "stored-web-token-0123456789abcdef"
        try "\(stored)\n".write(to: state.appendingPathComponent("web/token"), atomically: true, encoding: .utf8)
        let server = try MockServer { r, i in
            r.headers["authorization"] == "Bearer \(stored)" ? desksHandler(r, i) : .json(401, #"{"error":"unauthorized"}"#)
        }
        try await server.start()
        defer { server.stop() }
        let proc = BackendProcess(logURL: FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-boot-unused.log"))
        let l = BackendLauncher(isExecutable: { _ in false }, runCapture: { _, _ in nil })
        var s = AppSettings()
        s.port = server.port
        s.stateDir = state.path
        let out = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil)
        if case .reused = out {} else { Issue.record("expected reuse with the stored token, got \(out)") }
        s.token = "settings-token-wins-0000"
        if case .failed(let m) = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil) {
            #expect(m.contains("401"))
        } else { Issue.record("a non-empty Settings token must win over the file") }
    }

    @Test func effectiveTokenFollowsTheCLIStateDirRule() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-home-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: home) }
        var s = AppSettings()
        #expect(s.webTokenPath(environment: [:], home: home) == home + "/.agentic-coding-harness/web/token")
        #expect(s.webTokenPath(environment: ["AGENTIC_CODING_HARNESS_STATE_DIR": "/env/state"], home: home) == "/env/state/web/token")
        #expect(s.webTokenPath(environment: ["AGENTIC_CODING_HARNESS_STATE_DIR": ""], home: home) == home + "/.agentic-coding-harness/web/token")
        #expect(s.effectiveToken(environment: [:], home: home) == nil, "no file yet")
        let dir = home + "/.agentic-coding-harness/web"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try "short\n".write(toFile: dir + "/token", atomically: true, encoding: .utf8)
        #expect(s.effectiveToken(environment: [:], home: home) == nil, "too short to be a real token")
        try "  abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG\n".write(toFile: dir + "/token", atomically: true, encoding: .utf8)
        #expect(s.effectiveToken(environment: [:], home: home) == "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")
        s.stateDir = "/settings/state"
        #expect(s.webTokenPath(environment: ["AGENTIC_CODING_HARNESS_STATE_DIR": "/env/state"], home: home) == "/settings/state/web/token")
        s.token = "explicit"
        #expect(s.effectiveToken(environment: [:], home: home) == "explicit")
        #expect(s.serverConfig.token == "explicit")
    }

    @Test func bootReusesServingAndRefusesOccupiedOrMissing() async throws {
        let proc = BackendProcess(logURL: FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-boot-unused.log"))
        let ok = try MockServer(handler: desksHandler)
        try await ok.start()
        var s = AppSettings()
        s.stateDir = "/nonexistent/ach-desk-test-state" // never read the real ~/.agentic-coding-harness/web/token
        s.port = ok.port
        let l = BackendLauncher(isExecutable: { _ in false }, runCapture: { _, _ in nil })
        if case .reused = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil) {} else { Issue.record("expected reuse") }
        let free = ok.port
        ok.stop()

        let bad = try MockServer { _, _ in .json(404, "nope") }
        try await bad.start()
        defer { bad.stop() }
        s.port = bad.port
        if case .failed(let m) = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil) {
            #expect(m.contains("404"))
        } else { Issue.record("expected failure on occupied port") }

        try await Task.sleep(nanoseconds: 100_000_000)
        s.port = free
        if case .failed(let m) = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil) {
            #expect(m.contains("Could not find ach"))
        } else { Issue.record("expected failure without ach") }
        s.autoStartBackend = false
        if case .failed(let m) = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil) {
            #expect(m.contains("auto-start is off"))
        } else { Issue.record("expected failure with auto-start off") }
        #expect(!proc.isRunning)
    }

    @Test func backendProcessStartsDetachedAndStopsCleanly() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("logs/proc.log")
        // A fake ach: logs its argv, then stays up like `ach web` would.
        let p2 = BackendProcess(logURL: log)
        let script = dir.appendingPathComponent("fake-ach.sh").path
        try "#!/bin/sh\necho \"fake ach $@\"\nexec sleep 30\n".write(toFile: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script)
        try p2.start(achPath: script, port: 9999, environment: ["PATH": "/usr/bin:/bin"])
        let pid = p2.process!.processIdentifier
        let want = "fake ach web --port 9999 --no-open"
        // Wait for the child to write its argv (a fixed sleep raced on a loaded machine).
        let logged = await eventually(timeout: 10) { ((try? String(contentsOf: log, encoding: .utf8)) ?? "").contains(want) }
        #expect(logged)
        #expect(p2.isRunning)
        p2.stop(grace: 2)
        #expect(!p2.isRunning)
        #expect(kill(pid, 0) != 0) // gone
        let logText = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        #expect(logText.contains(want))
    }

    private func fakeAch(_ dir: URL, body: String) throws -> String {
        let script = dir.appendingPathComponent("fake-ach-\(UUID().uuidString).sh").path
        try "#!/bin/sh\n\(body)\n".write(toFile: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script)
        return script
    }

    @Test func startRefusesWhileAChildIsRunning() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let proc = BackendProcess(logURL: dir.appendingPathComponent("p.log"))
        let script = try fakeAch(dir, body: "exec sleep 30")
        try proc.start(achPath: script, port: 1, environment: ["PATH": "/usr/bin:/bin"])
        let first = proc.process!
        defer { proc.stop(grace: 2) }
        #expect(throws: BackendProcess.StartError.self) {
            try proc.start(achPath: script, port: 1, environment: ["PATH": "/usr/bin:/bin"])
        }
        #expect(proc.process === first) // the original child is kept, not overwritten
        #expect(first.isRunning)
    }

    @Test func probeTimeoutIsNotNotRunning() async throws {
        let slow = try MockServer { _, _ in
            Thread.sleep(forTimeInterval: 4)
            return .json(200, "{}")
        }
        try await slow.start()
        defer { slow.stop() }
        let r = await BackendLauncher.probe(APIClient(config: ServerConfig(port: slow.port)))
        #expect(r != .notRunning)
        if case .occupied = r {} else { Issue.record("expected occupied for a timeout, got \(r)") }
    }

    @Test func bootTimeoutStopsTheChild() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let proc = BackendProcess(logURL: dir.appendingPathComponent("p.log"))
        let script = try fakeAch(dir, body: "exec sleep 30")
        let probeServer = try MockServer(handler: desksHandler)
        try await probeServer.start()
        let free = probeServer.port
        probeServer.stop()
        try await Task.sleep(nanoseconds: 100_000_000)
        var s = AppSettings()
        s.stateDir = "/nonexistent/ach-desk-test-state" // never read the real ~/.agentic-coding-harness/web/token
        s.port = free
        let l = BackendLauncher(isExecutable: { _ in true }, runCapture: { _, args in args.last == "command -v ach" ? script : nil })
        let out = await BackendBoot.ensure(settings: s, launcher: l, process: proc, bundledAchPath: nil, waitSeconds: 1)
        if case .failed(let m) = out { #expect(m.contains("did not answer")) } else { Issue.record("expected failure, got \(out)") }
        #expect(!proc.isRunning)
    }

    @Test func captureTimesOutOnAHungCommand() {
        let t0 = Date()
        let out = BackendLauncher.capture("/bin/sleep", ["30"], 0.5)
        #expect(out == nil)
        #expect(Date().timeIntervalSince(t0) < 5)
    }

    @Test func startClosesItsLogHandle() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ach-desk-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let proc = BackendProcess(logURL: dir.appendingPathComponent("p.log"))
        let script = try fakeAch(dir, body: "exit 0")
        func openFDs() -> Int { (try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count) ?? 0 }
        let before = openFDs()
        for _ in 0..<20 {
            try proc.start(achPath: script, port: 1, environment: ["PATH": "/usr/bin:/bin"])
            proc.process?.waitUntilExit()
        }
        #expect(openFDs() - before < 10) // 20 leaked handles would add ~20
    }
}
