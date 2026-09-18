import type { UsageRow, UsageScan } from "@earendil-works/pi-agent-core";
import type { PostgresQueryable } from "../types.ts";

export interface UsageLedgerRow {
	id: string;
	seq: number;
	entry_id: string | null;
	adjustment: boolean;
	/** JSON columns, already parsed by the client. */
	usage: unknown;
	details: unknown | null;
}

export async function insertUsageLedgerRow(sql: PostgresQueryable, sessionId: string, row: UsageRow): Promise<void> {
	await sql`INSERT INTO usage_ledger (session_id, id, seq, entry_id, adjustment, usage, details)
		VALUES (
			${sessionId},
			${row.id},
			${row.seq},
			${row.entryId ?? null},
			${row.adjustment},
			${JSON.stringify(row.usage)}::text::json,
			${row.details === undefined ? null : JSON.stringify(row.details)}::text::json
		)`;
}

/** Ids from `ids` that exist as usage rows in this session. */
export async function readExistingUsageIds(
	sql: PostgresQueryable,
	sessionId: string,
	ids: readonly string[],
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const rows = await sql<{ id: string }[]>`SELECT id FROM usage_ledger
		WHERE session_id = ${sessionId} AND id = ANY(${[...ids]}::text[])`;
	return new Set(rows.map((row) => row.id));
}

export function decodeUsageLedgerRow(row: UsageLedgerRow): UsageRow {
	return {
		id: row.id,
		seq: row.seq,
		usage: row.usage as UsageRow["usage"],
		...(row.entry_id === null ? {} : { entryId: row.entry_id }),
		adjustment: row.adjustment,
		...(row.details === null ? {} : { details: row.details as UsageRow["details"] }),
	};
}

export async function scanUsageLedgerRows(
	sql: PostgresQueryable,
	sessionId: string,
	query: UsageScan,
): Promise<UsageLedgerRow[]> {
	const descending = query.order === "desc";
	return sql<UsageLedgerRow[]>`SELECT id, seq, entry_id, adjustment, usage, details
		FROM usage_ledger
		WHERE session_id = ${sessionId}
			${query.fromSeq === undefined ? sql`` : sql`AND seq >= ${query.fromSeq}`}
			${query.toSeq === undefined ? sql`` : sql`AND seq <= ${query.toSeq}`}
		${descending ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`}
		${query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`}`;
}
