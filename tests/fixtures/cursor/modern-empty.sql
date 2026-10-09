CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
INSERT INTO cursorDiskKV VALUES ('bubbleId:comp-x:zero-1', '{"type":1,"createdAt":"2026-09-27T01:00:00.000Z","tokenCount":{"inputTokens":0,"outputTokens":0}}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:comp-x:zero-2', '{"type":2,"createdAt":"2026-09-27T01:00:01.000Z","tokenCount":{"inputTokens":0,"outputTokens":0}}');
INSERT INTO cursorDiskKV VALUES ('composerData:comp-x', '{"modelConfig":{"modelName":"default"},"contextTokensUsed":88888}');
INSERT INTO cursorDiskKV VALUES ('agentKv:blob:aaaa', '{"role":"user","content":"hi","providerOptions":{"cursor":{"requestId":"r1","modelName":"default"}}}');
INSERT INTO cursorDiskKV VALUES ('agentKv:blob:bbbb', '{"role":"assistant","content":"hello","providerOptions":{"cursor":{"requestId":"r1","modelName":"default"}}}');
INSERT INTO cursorDiskKV VALUES ('agentKv:blob:cccc', '{"role":"tool","content":"x","providerOptions":{"cursor":{"requestId":"r2","modelName":"default"}}}');
