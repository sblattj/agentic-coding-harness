import Foundation
import Testing
@testable import AchDeskCore

@Suite struct SSEParserTests {
    @Test func multiLineDataJoinedWithNewline() {
        var p = SSEParser()
        let out = p.feed("data: first\ndata: second\ndata:third\n\n")
        #expect(out == [SSEEvent(event: "message", data: "first\nsecond\nthird", id: nil)])
    }

    @Test func commentsAndKeepalivesIgnored() {
        var p = SSEParser()
        let out = p.feed(": keepalive\n\n:another\ndata: x\n: mid comment\n\n")
        #expect(out.map(\.data) == ["x"])
    }

    @Test func partialChunksAcrossLineAndEventBoundaries() {
        var p = SSEParser()
        var all: [SSEEvent] = []
        for chunk in ["da", "ta: {\"kind\":", "\"message\"}", "\n", "\n", "data: b\n", "\ndata: c"] {
            all += p.feed(chunk)
        }
        #expect(all.map(\.data) == ["{\"kind\":\"message\"}", "b"])
        all += p.feed("\n\n")
        #expect(all.map(\.data) == ["{\"kind\":\"message\"}", "b", "c"])
    }

    @Test func crlfAndBareCrLineEndings() {
        var p = SSEParser()
        var out = p.feed("data: a\r\n\r\n")
        out += p.feed("data: b\r\r")
        // CRLF split across chunks must not produce an extra blank line
        out += p.feed("data: c\r")
        out += p.feed("\ndata: d\r\n\r\n")
        #expect(out.map(\.data) == ["a", "b", "c\nd"])
    }

    @Test func eventIdRetryAndNamedEvents() {
        var p = SSEParser()
        let out = p.feed("event: ping\nid: 41\nretry: 2500\ndata: x\n\ndata: y\n\n")
        #expect(out[0] == SSEEvent(event: "ping", data: "x", id: "41"))
        #expect(out[1] == SSEEvent(event: "message", data: "y", id: "41")) // last id carries over
        #expect(p.lastEventID == "41")
        #expect(p.retryMs == 2500)
    }

    @Test func blankEventWithoutDataNotDispatched() {
        var p = SSEParser()
        #expect(p.feed("event: x\n\n\n\n").isEmpty)
    }

    @Test func resetDropsHalfEventButKeepsReconnectState() {
        var p = SSEParser()
        _ = p.feed("id: 7\nretry: 100\ndata: done\n\ndata: half")
        p.reset() // connection dropped mid-event
        let out = p.feed("data: fresh\n\n")
        #expect(out.map(\.data) == ["fresh"])
        #expect(p.lastEventID == "7")
        #expect(p.retryMs == 100)
    }

    @Test func utf8SplitAcrossChunks() {
        var p = SSEParser()
        let bytes = Array("data: caf\u{00E9} \u{1F600}\n\n".utf8)
        var out: [SSEEvent] = []
        for b in bytes { out += p.feed(Data([b])) }
        #expect(out.map(\.data) == ["caf\u{00E9} \u{1F600}"])
    }

    @Test func backoffDoublesCapsResetsAndGatesPolling() {
        var b = Backoff(base: 0.5, cap: 4)
        #expect(!b.shouldPoll)
        #expect(b.nextDelay() == 0.5)
        #expect(!b.shouldPoll)
        #expect(b.nextDelay() == 1)
        #expect(b.shouldPoll)
        #expect(b.nextDelay() == 2)
        #expect(b.nextDelay() == 4)
        #expect(b.nextDelay() == 4)
        #expect(b.failures == 5)
        b.reset()
        #expect(b.failures == 0)
        #expect(!b.shouldPoll)
        #expect(b.nextDelay() == 0.5)
    }
}
