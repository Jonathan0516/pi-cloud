import type { PostgresQueryable } from "../types.ts";

export async function readNextSeq(sql: PostgresQueryable, sessionId: string): Promise<number> {
	const [row] = await sql<{ next_seq: number }[]>`SELECT next_seq FROM sessions WHERE id = ${sessionId}`;
	if (row === undefined) throw new Error(`Unknown PostgreSQL session: ${sessionId}`);
	return row.next_seq;
}

export async function advanceNextSeq(sql: PostgresQueryable, sessionId: string, nextSeq: number): Promise<void> {
	const result = await sql`UPDATE sessions SET next_seq = ${nextSeq} WHERE id = ${sessionId}`;
	if (result.count !== 1) {
		throw new Error(`Expected to update one PostgreSQL session ${sessionId}, updated ${result.count}`);
	}
}
