import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	Entry,
	EntryScan,
	EntryStructure,
	MessageEntry,
} from "@earendil-works/pi-agent-core";
import type { PostgresQueryable } from "../types.ts";

export interface EntryRow {
	id: string;
	parent_id: string | null;
	seq: number;
	type: Entry["type"];
	custom_type: string | null;
	timestamp: number;
	/** JSON column, already parsed by the client. */
	payload: unknown;
}

type StoredEntryPayload<TEntry extends Entry> = Omit<
	TEntry,
	"id" | "parentId" | "seq" | "timestamp" | "type" | "customType"
>;

function entryPayload(entry: Entry): StoredEntryPayload<Entry> {
	switch (entry.type) {
		case "message": {
			const payload: StoredEntryPayload<MessageEntry> = {
				message: entry.message,
				...(entry.terminate === undefined ? {} : { terminate: entry.terminate }),
			};
			return payload;
		}
		case "compaction": {
			const payload: StoredEntryPayload<CompactionEntry> = {
				summary: entry.summary,
				retainedTail: entry.retainedTail,
				tokensBefore: entry.tokensBefore,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: entry.usage }),
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "branch_summary": {
			const payload: StoredEntryPayload<BranchSummaryEntry> = {
				fromId: entry.fromId,
				summary: entry.summary,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: entry.usage }),
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "custom": {
			const payload: StoredEntryPayload<CustomEntry> = entry.data === undefined ? {} : { data: entry.data };
			return payload;
		}
	}
}

function storedPayload<TEntry extends Entry>(row: EntryRow): StoredEntryPayload<TEntry> {
	return row.payload as StoredEntryPayload<TEntry>;
}

export async function insertEntryRow(sql: PostgresQueryable, sessionId: string, entry: Entry): Promise<void> {
	await sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
		VALUES (
			${sessionId},
			${entry.id},
			${entry.parentId},
			${entry.seq},
			${entry.type},
			${entry.type === "custom" ? entry.customType : null},
			${entry.timestamp},
			${JSON.stringify(entryPayload(entry))}::text::json
		)`;
}

export function decodeEntryRow(row: EntryRow): Entry {
	const base = {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
	};
	switch (row.type) {
		case "message":
			return { ...base, type: "message", ...storedPayload<MessageEntry>(row) };
		case "compaction":
			return { ...base, type: "compaction", ...storedPayload<CompactionEntry>(row) };
		case "branch_summary":
			return { ...base, type: "branch_summary", ...storedPayload<BranchSummaryEntry>(row) };
		case "custom":
			if (row.custom_type === null) throw new Error(`Custom entry ${row.id} is missing custom_type`);
			return { ...base, type: "custom", customType: row.custom_type, ...storedPayload<CustomEntry>(row) };
	}
}

export function entryStructureFromRow(row: Omit<EntryRow, "payload">): EntryStructure {
	return {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
	};
}

export async function readEntryRows(
	sql: PostgresQueryable,
	sessionId: string,
	ids: readonly string[],
): Promise<EntryRow[]> {
	if (ids.length === 0) return [];
	return sql<EntryRow[]>`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId} AND id = ANY(${[...ids]}::text[])`;
}

/** Ids from `ids` that exist as entries in this session. */
export async function readExistingEntryIds(
	sql: PostgresQueryable,
	sessionId: string,
	ids: readonly string[],
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const rows = await sql<{ id: string }[]>`SELECT id FROM entries
		WHERE session_id = ${sessionId} AND id = ANY(${[...ids]}::text[])`;
	return new Set(rows.map((row) => row.id));
}

export async function readAllEntryRows(sql: PostgresQueryable, sessionId: string): Promise<EntryRow[]> {
	return sql<EntryRow[]>`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`;
}

export async function scanEntryRows(sql: PostgresQueryable, sessionId: string, query: EntryScan): Promise<EntryRow[]> {
	const descending = query.order === "desc";
	return sql<EntryRow[]>`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries
		WHERE session_id = ${sessionId}
			${query.type === undefined ? sql`` : sql`AND type = ${query.type}`}
			${query.customType === undefined ? sql`` : sql`AND custom_type = ${query.customType}`}
			${query.fromSeq === undefined ? sql`` : sql`AND seq >= ${query.fromSeq}`}
			${query.toSeq === undefined ? sql`` : sql`AND seq <= ${query.toSeq}`}
		${descending ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`}
		${query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`}`;
}
