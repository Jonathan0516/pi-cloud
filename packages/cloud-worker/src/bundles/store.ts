/**
 * Bundle storage in PostgreSQL: the manifest as a row, the files as one gzip-compressed JSON blob.
 * Bundles are small text (skills, prompts), so the database is the right place for Phase 1; the
 * S3 variant of the design swaps `readBundleFiles`/`writeBundleFiles` and keeps the manifest row.
 * `tenant_bundles` holds each tenant's current default, the version new sessions are pinned to.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import type { PostgresClient, PostgresQueryable } from "@earendil-works/pi-session-backend-postgres";
import {
	type BundleFiles,
	type BundleManifest,
	BundleValidationError,
	buildManifest,
	bundleVersion,
	verifyBundleFiles,
} from "./manifest.ts";

export interface StoredBundle {
	version: string;
	tenant: string;
	manifest: BundleManifest;
	size: number;
	createdAt: Date;
}

export interface BundleWithFiles extends StoredBundle {
	files: BundleFiles;
}

export async function ensureBundleSchema(sql: PostgresQueryable): Promise<void> {
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS resource_bundles (
	version TEXT PRIMARY KEY,
	tenant_id TEXT NOT NULL,
	manifest JSON NOT NULL,
	blob BYTEA NOT NULL,
	size BIGINT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
	await sql.unsafe(
		`CREATE INDEX IF NOT EXISTS ix_resource_bundles_tenant ON resource_bundles(tenant_id, created_at DESC)`,
	);
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS tenant_bundles (
	tenant_id TEXT PRIMARY KEY,
	version TEXT NOT NULL REFERENCES resource_bundles(version),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);
}

function encodeFiles(files: BundleFiles): Buffer {
	const record: Record<string, string> = {};
	for (const [path, bytes] of files) record[path] = Buffer.from(bytes).toString("base64");
	return gzipSync(Buffer.from(JSON.stringify(record), "utf8"));
}

function decodeFiles(blob: Uint8Array): BundleFiles {
	const record = JSON.parse(gunzipSync(blob).toString("utf8")) as Record<string, string>;
	return new Map(
		Object.entries(record).map(([path, base64]) => [path, new Uint8Array(Buffer.from(base64, "base64"))]),
	);
}

interface BundleRow {
	version: string;
	tenant_id: string;
	manifest: BundleManifest;
	size: number;
	created_at: Date;
}

function toStored(row: BundleRow): StoredBundle {
	return {
		version: row.version,
		tenant: row.tenant_id,
		manifest: row.manifest,
		size: row.size,
		createdAt: row.created_at,
	};
}

/**
 * Store a bundle for a tenant. The same files always yield the same version, so publishing twice is
 * a no-op that reports `created: false`; a version owned by another tenant is refused.
 */
export async function publishBundle(
	sql: PostgresClient,
	tenant: string,
	files: BundleFiles,
	registers?: Partial<BundleManifest["registers"]>,
): Promise<{ bundle: StoredBundle; created: boolean }> {
	const manifest = buildManifest(files, registers);
	const version = bundleVersion(manifest);
	const existing = await readBundle(sql, version);
	if (existing !== undefined) {
		if (existing.tenant !== tenant) throw new BundleValidationError(`Bundle ${version} belongs to another tenant`);
		return { bundle: existing, created: false };
	}
	const blob = encodeFiles(files);
	const size = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
	const [row] = await sql<BundleRow[]>`INSERT INTO resource_bundles (version, tenant_id, manifest, blob, size)
		VALUES (${version}, ${tenant}, ${JSON.stringify(manifest)}::text::json, ${blob}, ${size})
		ON CONFLICT (version) DO NOTHING
		RETURNING version, tenant_id, manifest, size, created_at`;
	if (row === undefined) {
		// Lost a race with an identical publish.
		const raced = await readBundle(sql, version);
		if (raced === undefined) throw new Error(`Bundle ${version} vanished after a conflicting insert`);
		return { bundle: raced, created: false };
	}
	return { bundle: toStored(row), created: true };
}

export async function readBundle(sql: PostgresQueryable, version: string): Promise<StoredBundle | undefined> {
	const [row] = await sql<BundleRow[]>`SELECT version, tenant_id, manifest, size, created_at
		FROM resource_bundles WHERE version = ${version}`;
	return row === undefined ? undefined : toStored(row);
}

/** The bundle with its files, verified against the manifest before it is handed out. */
export async function readBundleWithFiles(
	sql: PostgresQueryable,
	version: string,
): Promise<BundleWithFiles | undefined> {
	const [row] = await sql<
		(BundleRow & { blob: Uint8Array })[]
	>`SELECT version, tenant_id, manifest, size, created_at, blob
		FROM resource_bundles WHERE version = ${version}`;
	if (row === undefined) return undefined;
	const files = decodeFiles(row.blob);
	verifyBundleFiles(row.manifest, files);
	if (bundleVersion(row.manifest) !== row.version) {
		throw new BundleValidationError(`Stored manifest of ${row.version} does not hash to its version`);
	}
	return { ...toStored(row), files };
}

export async function listBundles(sql: PostgresQueryable, tenant: string): Promise<StoredBundle[]> {
	const rows = await sql<BundleRow[]>`SELECT version, tenant_id, manifest, size, created_at
		FROM resource_bundles WHERE tenant_id = ${tenant} ORDER BY created_at DESC`;
	return rows.map(toStored);
}

/** Make `version` the tenant's default for new sessions and idle upgrades. Must belong to the tenant. */
export async function setTenantBundle(sql: PostgresQueryable, tenant: string, version: string): Promise<StoredBundle> {
	const bundle = await readBundle(sql, version);
	if (bundle === undefined || bundle.tenant !== tenant) throw new BundleValidationError(`Unknown bundle: ${version}`);
	await sql`INSERT INTO tenant_bundles (tenant_id, version, updated_at) VALUES (${tenant}, ${version}, now())
		ON CONFLICT (tenant_id) DO UPDATE SET version = EXCLUDED.version, updated_at = now()`;
	return bundle;
}

export async function clearTenantBundle(sql: PostgresQueryable, tenant: string): Promise<boolean> {
	const result = await sql`DELETE FROM tenant_bundles WHERE tenant_id = ${tenant}`;
	return result.count === 1;
}

export async function tenantDefaultBundle(sql: PostgresQueryable, tenant: string): Promise<StoredBundle | undefined> {
	const [row] = await sql<BundleRow[]>`SELECT b.version, b.tenant_id, b.manifest, b.size, b.created_at
		FROM tenant_bundles t JOIN resource_bundles b ON b.version = t.version WHERE t.tenant_id = ${tenant}`;
	return row === undefined ? undefined : toStored(row);
}

/** Entry and custom types a session already holds; the upgrade rule compares them with a bundle's registrations. */
export async function readSessionEntryTypes(
	sql: PostgresQueryable,
	sessionId: string,
): Promise<{ entryTypes: string[]; customTypes: string[] }> {
	const rows = await sql<{ type: string; custom_type: string | null }[]>`SELECT DISTINCT type, custom_type
		FROM entries WHERE session_id = ${sessionId}`;
	return {
		entryTypes: [...new Set(rows.map((row) => row.type))].sort(),
		customTypes: [...new Set(rows.flatMap((row) => (row.custom_type === null ? [] : [row.custom_type])))].sort(),
	};
}
