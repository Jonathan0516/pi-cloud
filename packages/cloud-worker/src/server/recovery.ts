/**
 * Takeover ledger. A session that fails every time a node resumes it must not be taken over
 * forever; the counter here is the circuit breaker the lease table cannot provide.
 */

import type { PostgresClient, PostgresQueryable } from "@earendil-works/pi-session-backend-postgres";

export interface RecoveryRecord {
	sessionId: string;
	failures: number;
	faulted: boolean;
}

export async function ensureRecoverySchema(sql: PostgresQueryable): Promise<void> {
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS cloud_session_recovery (
	session_id TEXT PRIMARY KEY,
	failures INTEGER NOT NULL DEFAULT 0,
	faulted BOOLEAN NOT NULL DEFAULT FALSE,
	last_failure TEXT,
	last_failure_at TIMESTAMPTZ,
	last_success_at TIMESTAMPTZ,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
}

export async function readRecoveryRecords(
	sql: PostgresClient,
	sessionIds: readonly string[],
): Promise<Map<string, RecoveryRecord>> {
	if (sessionIds.length === 0) return new Map();
	const rows = await sql<
		{ session_id: string; failures: number; faulted: boolean }[]
	>`SELECT session_id, failures, faulted
		FROM cloud_session_recovery WHERE session_id = ANY(${[...sessionIds]}::text[])`;
	return new Map(
		rows.map((row) => [row.session_id, { sessionId: row.session_id, failures: row.failures, faulted: row.faulted }]),
	);
}

/** Count a failed resume; the session becomes faulted at `threshold` and stops being taken over automatically. */
export async function recordTakeoverFailure(
	sql: PostgresClient,
	sessionId: string,
	reason: string,
	threshold: number,
): Promise<RecoveryRecord> {
	const [row] = await sql<{ failures: number; faulted: boolean }[]>`INSERT INTO cloud_session_recovery
			(session_id, failures, faulted, last_failure, last_failure_at, updated_at)
		VALUES (${sessionId}, 1, ${threshold <= 1}, ${reason.slice(0, 2000)}, now(), now())
		ON CONFLICT (session_id) DO UPDATE
			SET failures = cloud_session_recovery.failures + 1,
				faulted = cloud_session_recovery.failures + 1 >= ${threshold},
				last_failure = EXCLUDED.last_failure,
				last_failure_at = now(),
				updated_at = now()
		RETURNING failures, faulted`;
	return { sessionId, failures: row!.failures, faulted: row!.faulted };
}

/** A resume that stayed healthy clears the counter. */
export async function recordTakeoverSuccess(sql: PostgresClient, sessionId: string): Promise<void> {
	await sql`INSERT INTO cloud_session_recovery (session_id, failures, faulted, last_success_at, updated_at)
		VALUES (${sessionId}, 0, FALSE, now(), now())
		ON CONFLICT (session_id) DO UPDATE
			SET failures = 0, faulted = FALSE, last_success_at = now(), updated_at = now()`;
}

/** Operator action: allow automatic takeover again. */
export async function clearFault(sql: PostgresClient, sessionId: string): Promise<void> {
	await sql`UPDATE cloud_session_recovery SET failures = 0, faulted = FALSE, updated_at = now() WHERE session_id = ${sessionId}`;
}

/** Whether the session has a durable operation that a resumed worker would continue. */
export async function hasOpenOperation(sql: PostgresClient, sessionId: string): Promise<boolean> {
	const rows = await sql<{ present: number }[]>`SELECT 1 AS present FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = 'pi.op.state' LIMIT 1`;
	return rows.length > 0;
}

/**
 * Sessions with durable operation state and no live holder: the lease expired (a dead node) or was
 * released mid-run (a node that drained). Either way nobody will finish the work unless a node does.
 */
export async function listOrphanedOperations(sql: PostgresClient, limit: number): Promise<string[]> {
	const rows = await sql<{ session_id: string }[]>`SELECT DISTINCT v.session_id
		FROM scalar_values v
		LEFT JOIN session_leases l ON l.session_id = v.session_id
		WHERE v.namespace = 'pi.op.state'
			AND (l.session_id IS NULL OR l.state = 'free' OR l.expires_at < now())
		ORDER BY v.session_id
		LIMIT ${limit}`;
	return rows.map((row) => row.session_id);
}
