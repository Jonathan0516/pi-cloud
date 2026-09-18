-- AgentHarness storage format 4 / storageVersion 1.
-- One PostgreSQL schema is a session container holding any number of sessions;
-- every durable row is scoped by session_id. Authoritative durable state is
-- entries + scalar_values + list_values + usage_ledger; branch_* and the stats
-- columns on sessions are maintained projections/caches.
--
-- Text keys that are range-scanned use COLLATE "C" so prefix scans and
-- ORDER BY key compare by code point like the other backends, independent of
-- the database's default collation.

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	created_at BIGINT NOT NULL,
	parent_session_id TEXT,
	storage_version INTEGER NOT NULL,
	metadata JSON,
	message_count INTEGER NOT NULL,
	usage_payload JSON NOT NULL,
	next_seq BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	parent_id TEXT,
	seq BIGINT NOT NULL,
	type TEXT NOT NULL,
	custom_type TEXT,
	timestamp BIGINT NOT NULL,
	payload JSON NOT NULL,
	PRIMARY KEY (session_id, id)
);

CREATE INDEX IF NOT EXISTS ix_entry_parent ON entries(session_id, parent_id);
CREATE INDEX IF NOT EXISTS ix_entry_seq ON entries(session_id, seq, type);

CREATE TABLE IF NOT EXISTS scalar_values (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	namespace TEXT COLLATE "C" NOT NULL,
	key TEXT COLLATE "C" NOT NULL,
	seq BIGINT NOT NULL,
	value JSON NOT NULL,
	PRIMARY KEY (session_id, namespace, key)
);

CREATE TABLE IF NOT EXISTS list_values (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	namespace TEXT COLLATE "C" NOT NULL,
	key TEXT COLLATE "C" NOT NULL,
	seq BIGINT NOT NULL,
	value JSON NOT NULL,
	PRIMARY KEY (session_id, namespace, key, seq)
);

CREATE TABLE IF NOT EXISTS usage_ledger (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	seq BIGINT NOT NULL,
	entry_id TEXT,
	adjustment BOOLEAN NOT NULL,
	usage JSON NOT NULL,
	details JSON,
	PRIMARY KEY (session_id, id)
);

CREATE INDEX IF NOT EXISTS ix_usage_seq ON usage_ledger(session_id, seq);

-- Private branch index. Not values/lists; no equivalent in the other backends.
CREATE TABLE IF NOT EXISTS branch_entries (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	branch_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	entry_seq BIGINT NOT NULL,
	entry_type TEXT NOT NULL,
	PRIMARY KEY (session_id, branch_id, entry_id)
);

-- Ordered scans. entry_seq must follow session_id, branch_id directly or ORDER
-- BY needs a sort; entry_id and entry_type trail so the index covers id-only reads.
CREATE INDEX IF NOT EXISTS ix_be_seq ON branch_entries(session_id, branch_id, entry_seq, entry_id, entry_type);
-- Type-filtered scans.
CREATE INDEX IF NOT EXISTS ix_be_type ON branch_entries(session_id, branch_id, entry_type, entry_seq, entry_id);
CREATE INDEX IF NOT EXISTS ix_be_entry ON branch_entries(session_id, entry_id);

CREATE TABLE IF NOT EXISTS branch_meta (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	branch_id TEXT NOT NULL,
	tip_entry_id TEXT NOT NULL,
	tip_seq BIGINT NOT NULL,
	base_branch_id TEXT,
	base_seq BIGINT,
	PRIMARY KEY (session_id, branch_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_bm_tip ON branch_meta(session_id, tip_entry_id);
