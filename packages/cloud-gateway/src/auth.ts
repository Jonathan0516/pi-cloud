/**
 * API keys. The gateway stores only a SHA-256 of each key: a database read cannot yield a usable
 * credential, and lookups are exact matches on a hash of a high-entropy random string, so there is
 * no comparison to make constant-time.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PostgresQueryable } from "@earendil-works/pi-session-backend-postgres";
import { MIN_API_KEY_LENGTH } from "./config.ts";

/** Who a request acts as. */
export interface Principal {
	tenant: string;
	user: string;
}

export interface ApiKeyRecord extends Principal {
	keyHash: string;
	label: string | null;
	createdAt: Date;
	revokedAt: Date | null;
}

export const API_KEY_PREFIX = "pik_";

export async function ensureAuthSchema(sql: PostgresQueryable): Promise<void> {
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS gateway_api_keys (
	key_hash TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	label TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	revoked_at TIMESTAMPTZ
)`);
	await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_gateway_api_keys_tenant ON gateway_api_keys(tenant_id)`);
}

export function hashApiKey(key: string): string {
	return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A fresh key: 32 random bytes, base64url, prefixed so logs and secret scanners recognize it. */
export function generateApiKey(): string {
	return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function looksLikeApiKey(value: string): boolean {
	return value.length >= MIN_API_KEY_LENGTH && value.length <= 512 && /^[A-Za-z0-9_\-.]+$/.test(value);
}

/** Store a key for `principal`. Returns the key once; only its hash is kept. */
export async function createApiKey(
	sql: PostgresQueryable,
	principal: Principal,
	label?: string,
): Promise<{ key: string; keyHash: string }> {
	const key = generateApiKey();
	const keyHash = hashApiKey(key);
	await sql`INSERT INTO gateway_api_keys (key_hash, tenant_id, user_id, label)
		VALUES (${keyHash}, ${principal.tenant}, ${principal.user}, ${label ?? null})`;
	return { key, keyHash };
}

/** Install an operator-chosen key (bootstrap). Re-running with the same key is a no-op; a revoked one stays revoked. */
export async function installApiKey(
	sql: PostgresQueryable,
	key: string,
	principal: Principal,
	label = "bootstrap",
): Promise<void> {
	if (!looksLikeApiKey(key)) throw new Error("Bootstrap key is too short or contains unexpected characters");
	await sql`INSERT INTO gateway_api_keys (key_hash, tenant_id, user_id, label)
		VALUES (${hashApiKey(key)}, ${principal.tenant}, ${principal.user}, ${label})
		ON CONFLICT (key_hash) DO NOTHING`;
}

export async function authenticateApiKey(sql: PostgresQueryable, key: string): Promise<Principal | undefined> {
	if (!looksLikeApiKey(key)) return undefined;
	const [row] = await sql<{ tenant_id: string; user_id: string }[]>`SELECT tenant_id, user_id
		FROM gateway_api_keys WHERE key_hash = ${hashApiKey(key)} AND revoked_at IS NULL`;
	return row === undefined ? undefined : { tenant: row.tenant_id, user: row.user_id };
}

export async function revokeApiKey(sql: PostgresQueryable, keyHash: string): Promise<boolean> {
	const result = await sql`UPDATE gateway_api_keys SET revoked_at = now()
		WHERE key_hash = ${keyHash} AND revoked_at IS NULL`;
	return result.count === 1;
}

export async function listApiKeys(sql: PostgresQueryable, tenant?: string): Promise<ApiKeyRecord[]> {
	const rows = await sql<
		{
			key_hash: string;
			tenant_id: string;
			user_id: string;
			label: string | null;
			created_at: Date;
			revoked_at: Date | null;
		}[]
	>`SELECT key_hash, tenant_id, user_id, label, created_at, revoked_at FROM gateway_api_keys
		${tenant === undefined ? sql`` : sql`WHERE tenant_id = ${tenant}`}
		ORDER BY created_at`;
	return rows.map((row) => ({
		keyHash: row.key_hash,
		tenant: row.tenant_id,
		user: row.user_id,
		label: row.label,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	}));
}

/** Pull the bearer key out of an HTTP `Authorization` header. */
export function bearerToken(header: string | undefined): string | undefined {
	if (header === undefined) return undefined;
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	return match?.[1];
}
