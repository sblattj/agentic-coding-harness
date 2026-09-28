-- Synthetic Goose sessions.db (current schema, with usage_ledger).
-- Column names/types copied from block/goose
-- crates/goose/src/session/session_manager.rs (CREATE TABLE sessions /
-- usage_ledger) @ 98c626d74b5f0d3d272773f3cabf3252d927d14e, trimmed to the
-- columns the parser reads plus working_dir. Values are invented.
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    accumulated_total_tokens INTEGER,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER,
    accumulated_cache_read_tokens INTEGER,
    accumulated_cache_write_tokens INTEGER,
    accumulated_cost REAL,
    provider_name TEXT,
    model_config_json TEXT
);
CREATE TABLE usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_timestamp INTEGER NOT NULL,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost REAL,
    cost_source TEXT,
    is_compaction INTEGER DEFAULT 0
);
INSERT INTO sessions VALUES ('20260923_1', '/work/demo', '2026-09-23 14:00:00', 10400, 10000, 400, 8000, 1500, 10750, 10300, 450, 8000, 1500, 0.06, 'anthropic', '{"model_name":"claude-sonnet-4-5"}');
INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction)
  VALUES ('20260923_1', 1790172005, 'claude-sonnet-4-5', 10000, 400, 10400, 8000, 1500, 0.05, 'estimated', 0);
INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction)
  VALUES ('20260923_1', 1790172600, NULL, 300, 50, 350, 0, 0, 0.01, 'carried_forward', 0);
