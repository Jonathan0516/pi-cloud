/**
 * Tenant catalog: which tenant and user own each session. The session tables know nothing about
 * tenants; this table is the only place that does, and every gateway query goes through it.
 */

import type { Context } from "@earendil-works/pi-agent-core";
import {
	sessionBundleVersion,
	sessionLocation,
	sessionTenant,
	tenantDefaultBundle,
	WORKSPACE_CWD,
} from "@earendil-works/pi-cloud-worker";
import type { SessionSummary } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import {
	type PostgresClient,
	type PostgresQueryable,
	PostgresSessionRepo,
	readSessionLease,
	type SessionLease,
} from "@earendil-works/pi-session-backend-postgres";
import type { Principal } from "./auth.ts";

export interface TenantSession {
	id: string;
	tenant: string;
	user: string;
	title: string | null;
	createdAt: number;
}

/** REST view of a session: the catalog row plus where (if anywhere) it currently runs. */
export interface SessionView extends TenantSession {
	path: string;
	cwd: string;
	/** `running` while a live worker holds the lease. */
	state: "running" | "idle";
	owner: { node: string; addr: string } | null;
}

export async function ensureCatalogSchema(sql: PostgresQueryable): Promise<void> {
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS cloud_sessions (
	session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
	tenant_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	title TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
	await sql.unsafe(
		`CREATE INDEX IF NOT EXISTS ix_cloud_sessions_tenant ON cloud_sessions(tenant_id, created_at DESC)`,
	);
}

interface CatalogRow {
	session_id: string;
	tenant_id: string;
	user_id: string;
	title: string | null;
	created_at: number;
}

function toTenantSession(row: CatalogRow): TenantSession {
	return { id: row.session_id, tenant: row.tenant_id, user: row.user_id, title: row.title, createdAt: row.created_at };
}

/**
 * Create the session row and its catalog entry together, recording the tenant in the session and
 * pinning it to the tenant's current bundle. The worker that first attaches opens the existing
 * session; the gateway never spawns anything.
 */
export async function createTenantSession(
	sql: PostgresClient,
	principal: Principal,
	options: { title?: string; id?: string },
	context: Context,
): Promise<TenantSession> {
	const repo = new PostgresSessionRepo({ sql });
	try {
		const session = await repo.create(options.id === undefined ? undefined : { id: options.id }, context);
		const id = session.metadata.id;
		try {
			await session.setValue(sessionTenant, principal.tenant, context);
			const bundle = await tenantDefaultBundle(sql, principal.tenant);
			if (bundle !== undefined) await session.setValue(sessionBundleVersion, bundle.version, context);
		} finally {
			await session.close(context);
		}
		const [row] = await sql<CatalogRow[]>`INSERT INTO cloud_sessions (session_id, tenant_id, user_id, title)
			VALUES (${id}, ${principal.tenant}, ${principal.user}, ${options.title ?? null})
			RETURNING session_id, tenant_id, user_id, title,
				(SELECT created_at FROM sessions WHERE id = ${id}) AS created_at`;
		return toTenantSession(row!);
	} finally {
		await repo.close(context);
	}
}

export async function listTenantSessions(sql: PostgresQueryable, tenant: string): Promise<TenantSession[]> {
	const rows = await sql<CatalogRow[]>`SELECT c.session_id, c.tenant_id, c.user_id, c.title, s.created_at
		FROM cloud_sessions c JOIN sessions s ON s.id = c.session_id
		WHERE c.tenant_id = ${tenant}
		ORDER BY s.created_at DESC`;
	return rows.map(toTenantSession);
}

export async function findTenantSession(
	sql: PostgresQueryable,
	tenant: string,
	sessionId: string,
): Promise<TenantSession | undefined> {
	const [row] = await sql<CatalogRow[]>`SELECT c.session_id, c.tenant_id, c.user_id, c.title, s.created_at
		FROM cloud_sessions c JOIN sessions s ON s.id = c.session_id
		WHERE c.tenant_id = ${tenant} AND c.session_id = ${sessionId}`;
	return row === undefined ? undefined : toTenantSession(row);
}

/** Thrown when a session cannot be deleted because a worker holds it. */
export class SessionBusyError extends Error {
	constructor(sessionId: string) {
		super(`Session ${sessionId} is running; stop it before deleting`);
		this.name = "SessionBusyError";
	}
}

/**
 * Delete a session and everything under it (entries, values, lease, catalog row cascade). A session
 * with a live worker is refused: its worker would keep committing into rows that no longer exist.
 * The host workspace directory is left for the operator to reclaim.
 */
export async function deleteTenantSession(
	sql: PostgresClient,
	tenant: string,
	sessionId: string,
	context: Context,
): Promise<boolean> {
	const owned = await findTenantSession(sql, tenant, sessionId);
	if (owned === undefined) return false;
	if (liveLease(await readSessionLease(sql, sessionId)) !== undefined) throw new SessionBusyError(sessionId);
	const repo = new PostgresSessionRepo({ sql });
	try {
		const [metadata] = (await repo.list(undefined, context)).filter((candidate) => candidate.id === sessionId);
		if (metadata === undefined) return false;
		await repo.delete(metadata, context);
	} finally {
		await repo.close(context);
	}
	return true;
}

export function liveLease(lease: SessionLease | undefined, now = Date.now()): SessionLease | undefined {
	return lease !== undefined && lease.state === "held" && lease.expiresAt > now ? lease : undefined;
}

export async function describeSession(
	sql: PostgresQueryable,
	schema: string,
	session: TenantSession,
): Promise<SessionView> {
	const lease = liveLease(await readSessionLease(sql, session.id));
	return {
		...session,
		path: sessionLocation({ schema }, session.id),
		cwd: WORKSPACE_CWD,
		state: lease === undefined ? "idle" : "running",
		owner: lease === undefined ? null : { node: lease.owner.node, addr: lease.owner.addr },
	};
}

/** The mini `Sessions.list` shape, scoped to one tenant. */
export function toSessionSummary(schema: string, session: TenantSession): SessionSummary {
	return {
		id: session.id,
		path: sessionLocation({ schema }, session.id),
		cwd: WORKSPACE_CWD,
		createdAt: session.createdAt,
	};
}
