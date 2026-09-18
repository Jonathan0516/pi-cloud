import type { SessionStats, UsageRow } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { PostgresQueryable } from "../types.ts";
import { readSessionRow, type SessionRow } from "./session-row.ts";

export function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export function sessionStatsFromRow(row: SessionRow): SessionStats {
	return { messageCount: row.message_count, usage: row.usage_payload };
}

export async function readSessionStats(sql: PostgresQueryable, sessionId: string): Promise<SessionStats> {
	return sessionStatsFromRow(await readSessionRow(sql, sessionId));
}

/** Accumulates the stats effect of one commit so the session row is written once. */
export class SessionStatsAccumulator {
	private messageCount: number;
	private usage: Usage;

	constructor(current: SessionStats) {
		this.messageCount = current.messageCount;
		this.usage = current.usage;
	}

	countMessage(): void {
		this.messageCount += 1;
	}

	addUsage(usage: UsageRow["usage"]): void {
		this.usage = addUsage(this.usage, usage);
	}

	get stats(): SessionStats {
		return { messageCount: this.messageCount, usage: this.usage };
	}
}

/** Persist accumulated stats together with the advanced sequence in one statement. */
export async function writeSessionStatsAndSeq(
	sql: PostgresQueryable,
	sessionId: string,
	stats: SessionStats,
	nextSeq: number,
): Promise<void> {
	const result = await sql`UPDATE sessions
		SET message_count = ${stats.messageCount},
			usage_payload = ${JSON.stringify(stats.usage)}::text::json,
			next_seq = ${nextSeq}
		WHERE id = ${sessionId}`;
	if (result.count !== 1) {
		throw new Error(`Expected to update one PostgreSQL session ${sessionId}, updated ${result.count}`);
	}
}

export async function updateMessageCount(
	sql: PostgresQueryable,
	sessionId: string,
	messageCount: number,
): Promise<void> {
	await sql`UPDATE sessions SET message_count = ${messageCount} WHERE id = ${sessionId}`;
}
