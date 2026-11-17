// JSON fixtures shaped exactly like src/desks/types.ts (desks-api/1). Times are epoch ms.
// 1_763_380_800_000 = 2025-11-17T12:00:00Z (the tests pin "now" and the calendar to UTC).
import Foundation

enum Fixtures {
    static let noonMs: Double = 1_763_380_800_000
    static var noon: Date { Date(timeIntervalSince1970: noonMs / 1000) }

    // One desk (with a feed and an unknown extra field), one lane (goal + budget), one dead lane
    // started the day before, a pending lane, and an open decision.
    static let rosterView = """
    {
      "version": "desks-api/1",
      "stack": "default",
      "portBase": 4800,
      "me": "human",
      "futureField": {"anything": [1, 2, 3]},
      "rows": [
        {
          "name": "LISTENER", "kind": "desk", "role": "listener", "agent": "opencode", "engine": "opencode",
          "model": "ferry/super-flash", "mcps": ["whosaid"], "port": 4801, "url": "http://127.0.0.1:4801",
          "pid": 1001, "runId": "run-listener", "sessionId": "ses_1", "engineUrl": "http://127.0.0.1:5301",
          "cwd": "/tmp/work", "startedAt": 1763370000000, "feedPid": 2002,
          "terminal": {"kind": "tmux", "id": "%15"},
          "state": "busy", "queueDepth": 2, "costUsd": 0.42, "treeCostUsd": 1.92,
          "someNewServerField": true
        },
        {
          "name": "LANE1", "kind": "lane", "role": "lane", "agent": "claude", "engine": "driver",
          "mcps": [], "port": 4810, "url": "http://127.0.0.1:4810", "pid": 1003, "runId": "run-lane1",
          "parentRunId": "run-listener", "cwd": "/tmp/work", "startedAt": 1763377200000,
          "goal": "Write the docs", "launchedBy": "LISTENER", "budgetUsd": 5,
          "state": "idle", "queueDepth": 0,
          "goalStatus": {"objective": "Write the docs", "state": "active", "source": "ach-loop",
                         "plan": {"verified": 2, "total": 5}, "updatedAt": 1763380000000},
          "costUsd": 1.5, "treeCostUsd": 1.5
        },
        {
          "name": "LANE0", "kind": "lane", "role": "lane", "agent": "opencode", "engine": "opencode",
          "mcps": [], "port": 4811, "url": "http://127.0.0.1:4811", "pid": 1004, "runId": "run-lane0",
          "cwd": "/tmp/work", "startedAt": 1763290000000,
          "state": "dead", "queueDepth": 0, "costUsd": null, "treeCostUsd": null
        }
      ],
      "pendingLanes": [
        {"id": "L1", "request": {"name": "LANE2", "goal": "Refactor", "mcps": ["gh"], "launchedBy": "LISTENER"},
         "requestedAt": 1763380100000, "state": "pending"}
      ],
      "openDecisions": [
        {"id": "D1", "question": "Ship today?", "askedBy": "LANE1", "openedBy": "DECISIONS",
         "openedAt": 1763380200000, "state": "open",
         "options": [
           {"label": "Wait for review"},
           {"label": "Ship it", "recommended": true, "reason": "tests are green"},
           {"label": "Cancel"},
           {"label": "Ask Bob"}
         ]}
      ]
    }
    """

    static let messages = """
    {"messages": [
      {"id": "m1", "from": "human", "to": "LISTENER", "text": "hi", "at": 1763380300000, "delivered": "now"},
      {"id": "m2", "from": "LISTENER", "to": "LANE1", "text": "line one\\nline two", "at": 1763380400000, "delivered": "queued", "extra": 1}
    ]}
    """

    static let events = """
    {"events": [
      {"seq": 1, "at": 1763380400000, "runId": "run-listener", "name": "LISTENER", "type": "feed", "data": {"note": "call active"}},
      {"seq": 2, "at": 1763380500000, "runId": "run-listener", "name": "LISTENER", "type": "text", "data": {"text": "Talking point A"}},
      {"seq": 3, "at": 1763380600000, "runId": "run-listener", "name": "LISTENER", "type": "tool", "data": {"tool": "whosaid", "summary": "search"}},
      {"seq": 4, "at": 1763380700000, "runId": "run-listener", "name": "LISTENER", "type": "usage",
       "data": {"inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": 0.01}},
      {"seq": 5, "at": 1763380750000, "runId": "run-listener", "name": "LISTENER", "type": "brand_new_type", "data": {}},
      {"seq": 6, "at": 1763380760000, "runId": "run-listener", "name": "LISTENER", "type": "goal",
       "data": {"goal": {"objective": "x", "state": "achieved", "source": "opencode-plugin", "updatedAt": 1}}}
    ]}
    """

    static let costs = """
    {"rows": [
      {"name": "LISTENER", "kind": "desk", "runId": "run-listener", "costUsd": 0.42, "inputTokens": 1000, "outputTokens": 200,
       "lanes": [
         {"name": "LANE1", "kind": "lane", "runId": "run-lane1", "parentRunId": "run-listener", "costUsd": 1.5,
          "inputTokens": 5000, "outputTokens": 900, "lanes": []}
       ]},
      {"name": "LANE0", "kind": "lane", "runId": "run-lane0", "costUsd": null, "inputTokens": 0, "outputTokens": 0, "lanes": []}
    ]}
    """

    static let engines = """
    {"engines": [
      {"agent": "opencode", "found": true, "path": "/opt/homebrew/bin/opencode", "auth": "ok"},
      {"agent": "claude", "found": true, "path": "/Users/x/.local/bin/claude"},
      {"agent": "kiro", "found": false}
    ]}
    """

    static let mcps = """
    {"names": ["gh", "whosaid", "toolbox"]}
    """

    static let decisions = """
    {"decisions": [
      {"id": "D1", "question": "Ship today?", "askedBy": "LANE1", "openedBy": "DECISIONS", "openedAt": 1763380200000,
       "state": "answered", "options": [{"label": "Ship it", "recommended": true}],
       "answer": {"text": "Ship it", "by": "human", "at": 1763380900000}},
      {"id": "D2", "question": "Which model?", "askedBy": "LISTENER", "openedBy": "DECISIONS", "openedAt": 1763380950000,
       "state": "open", "options": []}
    ]}
    """

    static let rosterEntry = """
    {"name": "LANE3", "kind": "lane", "role": "lane", "agent": "claude", "engine": "driver", "mcps": ["gh"],
     "port": 4812, "url": "http://127.0.0.1:4812", "pid": 1010, "runId": "run-lane3", "cwd": "/tmp", "startedAt": 1763381000000}
    """

    static let pendingResult = """
    {"pending": {"id": "L2", "request": {"name": "LANE4", "goal": "g", "launchedBy": "human"}, "requestedAt": 1763381000000, "state": "pending"}}
    """

    static let message = """
    {"id": "m9", "from": "human", "to": "LISTENER", "text": "hello", "at": 1763381000000, "delivered": "now"}
    """

    static let answeredDecision = """
    {"id": "D1", "question": "Ship today?", "askedBy": "LANE1", "openedBy": "DECISIONS", "openedAt": 1763380200000,
     "state": "answered", "options": [], "answer": {"text": "Ship it", "by": "human", "at": 1763380900000}}
    """

    static func data(_ s: String) -> Data { Data(s.utf8) }
}
