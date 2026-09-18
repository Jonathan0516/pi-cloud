import type { PostgresQueryable } from "./types.ts";

export type LeaseState = "held" | "free";

/** Identity of the process that holds a lease. `addr` is where presentations can reach it. */
export interface LeaseOwner {
	node: string;
	addr: string;
	proc: string;
}

export interface SessionLease {
	sessionId: string;
	epoch: number;
	owner: LeaseOwner;
	state: LeaseState;
	/** Milliseconds since the Unix epoch, in database time. */
	heartbeatAt: number;
	expiresAt: number;
}

/**
 * What the previous holder left behind: nothing, a graceful release, or an expired lease. An expired
 * predecessor may still be running somewhere; callers fence its side effects (kill its sandbox).
 */
export type LeasePredecessor = "none" | "released" | "expired";

export type AcquireLeaseResult =
	| { acquired: true; lease: SessionLease; predecessor: LeasePredecessor }
	| { acquired: false; holder: SessionLease };

/** The lease this process holds on an open session. */
export interface OpenSessionLease {
	epoch: number;
	owner: LeaseOwner;
	predecessor: LeasePredecessor;
}

/** Raised when a commit or heartbeat finds that another process now owns the session. Deterministic: do not retry. */
export class FencedError extends Error {
	readonly code = "fenced";
	readonly sessionId: string;
	readonly epoch: number;

	constructor(sessionId: string, epoch: number, message?: string) {
		super(message ?? `Session ${sessionId} lease epoch ${epoch} is no longer held by this process`);
		this.name = "FencedError";
		this.sessionId = sessionId;
		this.epoch = epoch;
	}
}

export function isFencedError(error: unknown): error is FencedError {
	return error instanceof FencedError || (error instanceof Error && error.name === "FencedError");
}

/** Raised when opening a session whose lease another live process holds. `holder.owner.addr` says where. */
export class SessionLeaseHeldError extends Error {
	readonly code = "lease_held";
	readonly holder: SessionLease;

	constructor(holder: SessionLease) {
		super(
			`Session ${holder.sessionId} is held by ${holder.owner.node} (${holder.owner.addr}) until ${new Date(holder.expiresAt).toISOString()}`,
		);
		this.name = "SessionLeaseHeldError";
		this.holder = holder;
	}
}

interface LeaseRow {
	session_id: string;
	epoch: number;
	owner_node: string;
	owner_addr: string;
	owner_proc: string;
	state: LeaseState;
	heartbeat_at: Date;
	expires_at: Date;
}

interface AcquireRow extends LeaseRow {
	previous_state: LeaseState | null;
}

function decodeLeaseRow(row: LeaseRow): SessionLease {
	return {
		sessionId: row.session_id,
		epoch: row.epoch,
		owner: { node: row.owner_node, addr: row.owner_addr, proc: row.owner_proc },
		state: row.state,
		heartbeatAt: row.heartbeat_at.getTime(),
		expiresAt: row.expires_at.getTime(),
	};
}

export async function readSessionLease(sql: PostgresQueryable, sessionId: string): Promise<SessionLease | undefined> {
	const [row] = await sql<
		LeaseRow[]
	>`SELECT session_id, epoch, owner_node, owner_addr, owner_proc, state, heartbeat_at, expires_at
		FROM session_leases WHERE session_id = ${sessionId}`;
	return row === undefined ? undefined : decodeLeaseRow(row);
}

/**
 * Take the lease when nobody holds it, the holder released it, or the holder's lease expired. One
 * statement, one winner: concurrent acquirers serialize on the row and the loser's `WHERE` sees the
 * winner's fresh lease. Database `now()` decides expiry; node clocks never enter the comparison.
 */
export async function acquireSessionLease(
	sql: PostgresQueryable,
	sessionId: string,
	owner: LeaseOwner,
	ttlSeconds: number,
): Promise<AcquireLeaseResult> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const rows = await sql<AcquireRow[]>`WITH previous AS (
				SELECT state FROM session_leases WHERE session_id = ${sessionId}
			), upsert AS (
				INSERT INTO session_leases (session_id, epoch, owner_node, owner_addr, owner_proc, state, heartbeat_at, expires_at)
				VALUES (
					${sessionId}, 1, ${owner.node}, ${owner.addr}, ${owner.proc}, 'held', now(),
					now() + ${ttlSeconds}::double precision * interval '1 second'
				)
				ON CONFLICT (session_id) DO UPDATE
					SET epoch = session_leases.epoch + 1,
						owner_node = EXCLUDED.owner_node,
						owner_addr = EXCLUDED.owner_addr,
						owner_proc = EXCLUDED.owner_proc,
						state = 'held',
						heartbeat_at = now(),
						expires_at = EXCLUDED.expires_at
					WHERE session_leases.state = 'free' OR session_leases.expires_at < now()
				RETURNING session_id, epoch, owner_node, owner_addr, owner_proc, state, heartbeat_at, expires_at
			)
			SELECT upsert.*, previous.state AS previous_state FROM upsert LEFT JOIN previous ON TRUE`;
		const row = rows[0];
		if (row !== undefined) {
			const predecessor: LeasePredecessor =
				row.previous_state === null ? "none" : row.previous_state === "free" ? "released" : "expired";
			return { acquired: true, lease: decodeLeaseRow(row), predecessor };
		}
		const holder = await readSessionLease(sql, sessionId);
		if (holder !== undefined) return { acquired: false, holder };
		// The holder's row vanished between the two statements (session deleted); try once more.
	}
	throw new Error(`Lease for session ${sessionId} could not be read after a failed acquire`);
}

/** Graceful hand-off: the next acquirer does not wait for the TTL. Returns false when `epoch` is stale. */
export async function releaseSessionLease(sql: PostgresQueryable, sessionId: string, epoch: number): Promise<boolean> {
	const result = await sql`UPDATE session_leases SET state = 'free', expires_at = now()
		WHERE session_id = ${sessionId} AND epoch = ${epoch} AND state = 'held'`;
	return result.count === 1;
}

/**
 * Supervisor-side crash report: the holder is known dead, so its lease may be taken at once, but
 * with the `"expired"` predecessor so the taker still fences the dead holder's side effects. Keeps
 * `state = 'held'` and moves `expires_at` to now. Returns false when `epoch` is stale.
 */
export async function expireSessionLease(sql: PostgresQueryable, sessionId: string, epoch: number): Promise<boolean> {
	const result = await sql`UPDATE session_leases SET expires_at = now()
		WHERE session_id = ${sessionId} AND epoch = ${epoch} AND state = 'held'`;
	return result.count === 1;
}

/**
 * Renew every lease this process holds in one statement. The returned ids are still owned; any id
 * missing from the result was taken over and its worker must stop immediately.
 */
export async function heartbeatSessionLeases(
	sql: PostgresQueryable,
	leases: readonly { sessionId: string; epoch: number }[],
	ttlSeconds: number,
): Promise<Set<string>> {
	if (leases.length === 0) return new Set();
	const rows = await sql<{ session_id: string }[]>`UPDATE session_leases AS l
		SET heartbeat_at = now(), expires_at = now() + ${ttlSeconds}::double precision * interval '1 second'
		FROM unnest(${leases.map((lease) => lease.sessionId)}::text[], ${leases.map((lease) => lease.epoch)}::bigint[]) AS v(session_id, epoch)
		WHERE l.session_id = v.session_id AND l.epoch = v.epoch AND l.state = 'held'
		RETURNING l.session_id`;
	return new Set(rows.map((row) => row.session_id));
}

/**
 * The fence. Run as the first statement of a commit transaction: it renews the lease and, when the
 * epoch is no longer ours, throws {@link FencedError} so the transaction rolls back. A connection
 * failure surfaces as its own error and is retryable; a zero row count is not.
 */
export async function fenceSessionLease(
	sql: PostgresQueryable,
	sessionId: string,
	epoch: number,
	ttlSeconds: number,
): Promise<void> {
	const result = await sql`UPDATE session_leases
		SET heartbeat_at = now(), expires_at = now() + ${ttlSeconds}::double precision * interval '1 second'
		WHERE session_id = ${sessionId} AND epoch = ${epoch} AND state = 'held'`;
	if (result.count !== 1) throw new FencedError(sessionId, epoch);
}

/** Held leases whose holder went silent, oldest first. Input for a takeover reaper. */
export async function listExpiredSessionLeases(sql: PostgresQueryable, limit: number): Promise<SessionLease[]> {
	const rows = await sql<
		LeaseRow[]
	>`SELECT session_id, epoch, owner_node, owner_addr, owner_proc, state, heartbeat_at, expires_at
		FROM session_leases
		WHERE state = 'held' AND expires_at < now()
		ORDER BY expires_at ASC
		LIMIT ${Math.max(0, limit)}`;
	return rows.map(decodeLeaseRow);
}
