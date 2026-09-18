-- Session ownership. One row per session that has ever had a worker. The lease is both the
-- fence (commits renew it inside their own transaction and fail when the epoch moved on) and the
-- routing table (owner_addr says where the live worker is). All timestamps are database time.
CREATE TABLE IF NOT EXISTS session_leases (
	session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
	epoch BIGINT NOT NULL,
	owner_node TEXT NOT NULL,
	owner_addr TEXT NOT NULL,
	owner_proc TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('held', 'free')),
	heartbeat_at TIMESTAMPTZ NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL
);

-- The reaper scans only leases that were held and went silent.
CREATE INDEX IF NOT EXISTS ix_lease_expired ON session_leases (expires_at) WHERE state = 'held';
