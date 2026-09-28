-- Synthetic Goose sessions.db from before the usage_ledger migration:
-- sessions table only, no cache columns. Column names from block/goose
-- crates/goose/src/session/session_manager.rs @ 98c626d7 (the ALTER TABLE
-- migrations add cache/cost columns and usage_ledger later). Values invented.
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    working_dir TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    total_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    accumulated_total_tokens INTEGER,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER,
    provider_name TEXT,
    model_config_json TEXT
);
INSERT INTO sessions VALUES ('20250501_1', '/work/demo', '2025-05-01 01:02:03', 1000, 800, 200, 6000, 5000, 1000, 'openai', '{"model_name":"gpt-4o"}');
INSERT INTO sessions VALUES ('20250501_2', '/work/demo', '2025-05-01 02:00:00', 100, 70, 30, NULL, NULL, NULL, NULL, NULL);
INSERT INTO sessions VALUES ('20250501_3', '/work/demo', '2025-05-01 03:00:00', 0, 0, 0, 0, 0, 0, 'openai', '{"model_name":"gpt-4o"}');
INSERT INTO sessions VALUES ('20250501_4', '/work/demo', '2025-05-01 04:00:00', 15, 10, 5, 15, 10, 5, 'openai', '{not json');
