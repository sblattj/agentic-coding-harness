CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
INSERT INTO cursorDiskKV VALUES ('bubbleId:session-a:user', '{"type":1,"createdAt":"2026-09-27T01:00:00Z","tokenCount":{"inputTokens":120,"outputTokens":0}}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:session-a:assistant', '{"type":2,"createdAt":"2026-09-27T01:00:01Z","modelInfo":{"modelName":"gpt-5"},"tokenCount":{"inputTokens":0,"outputTokens":34}}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:session-a:no-usage', '{"type":2,"text":"Never estimate this text","tokenCount":{"inputTokens":0,"outputTokens":0}}');
INSERT INTO cursorDiskKV VALUES ('composerData:session-a', '{"contextTokensUsed":99999}');
