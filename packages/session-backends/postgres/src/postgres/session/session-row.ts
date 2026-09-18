import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { PostgresQueryable } from "../types.ts";

export interface SessionRow {
	id: string;
	created_at: number;
	parent_session_id: string | null;
	storage_version: number;
	metadata: unknown | null;
	message_count: number;
	/** JSON column, already parsed by the client. */
	usage_payload: Usage;
	next_seq: number;
}

/** Metadata for a PostgreSQL session. The client, not the metadata, names the database and schema. */
export type PostgresSessionMetadata = SessionMetadata;

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export async function readSessionRow(
	sql: PostgresQueryable,
	sessionId: string,
	options: { forUpdate?: boolean } = {},
): Promise<SessionRow> {
	const [row] = await sql<SessionRow[]>`SELECT id, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM sessions
		WHERE id = ${sessionId}
		${options.forUpdate ? sql`FOR UPDATE` : sql``}`;
	if (row === undefined) throw new Error(`Unknown PostgreSQL session: ${sessionId}`);
	return row;
}

export async function readAllSessionRows(sql: PostgresQueryable): Promise<SessionRow[]> {
	return sql<SessionRow[]>`SELECT id, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM sessions ORDER BY created_at DESC, id ASC`;
}

export async function hasSessionRow(sql: PostgresQueryable, sessionId: string): Promise<boolean> {
	const rows = await sql<{ id: string }[]>`SELECT id FROM sessions WHERE id = ${sessionId}`;
	return rows.length > 0;
}

export function metadataFromSessionRow(row: SessionRow, currentStorageVersion: number): PostgresSessionMetadata {
	if (row.storage_version > currentStorageVersion) {
		throw new Error(
			`PostgreSQL session storage version ${row.storage_version} is newer than ${currentStorageVersion}`,
		);
	}
	if (row.storage_version < currentStorageVersion) {
		throw new Error(`PostgreSQL session storage version ${row.storage_version} requires migrations`);
	}
	return {
		id: row.id,
		createdAt: row.created_at,
		storageVersion: row.storage_version,
		...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
	};
}

export async function insertSessionRow(
	sql: PostgresQueryable,
	metadata: PostgresSessionMetadata,
	storageVersion: number,
	nextSeq: number,
): Promise<void> {
	await sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
		VALUES (
			${metadata.id},
			${metadata.createdAt},
			${metadata.parentSessionId ?? null},
			${storageVersion},
			${null},
			${0},
			${JSON.stringify(zeroUsage())}::text::json,
			${nextSeq}
		)`;
}

/** Delete one session. Child rows cascade through their foreign keys. */
export async function deleteSessionRows(sql: PostgresQueryable, sessionId: string): Promise<void> {
	const result = await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
	if (result.count !== 1) {
		throw new Error(`Expected to delete one PostgreSQL session ${sessionId}, deleted ${result.count}`);
	}
}
