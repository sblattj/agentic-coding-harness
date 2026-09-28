CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
INSERT INTO cursorDiskKV VALUES ('bubbleId:bad:json', '{broken');
INSERT INTO cursorDiskKV VALUES ('bubbleId:bad:negative', '{"tokenCount":{"inputTokens":-1,"outputTokens":4}}');
INSERT INTO cursorDiskKV VALUES ('bubbleId:good:reported', '{"tokenCount":{"inputTokens":10,"outputTokens":2}}');
