import type { PostgresClient } from "@earendil-works/pi-session-backend-postgres";
import type { UsageCounts } from "./usage.ts";

/** One upstream call as the proxy saw it. Independent of the session usage ledger, which the harness owns. */
export interface BillingEvent {
	tenant: string;
	session: string;
	operation?: string;
	provider: string;
	model?: string;
	status: number;
	requestBytes: number;
	responseBytes: number;
	durationMs: number;
	streamed: boolean;
	usage?: UsageCounts;
	error?: string;
}

export async function ensureBillingSchema(sql: PostgresClient): Promise<void> {
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS billing_events (
	id BIGSERIAL PRIMARY KEY,
	at TIMESTAMPTZ NOT NULL DEFAULT now(),
	tenant TEXT NOT NULL,
	session TEXT NOT NULL,
	operation TEXT,
	provider TEXT NOT NULL,
	model TEXT,
	status INTEGER NOT NULL,
	request_bytes BIGINT NOT NULL,
	response_bytes BIGINT NOT NULL,
	duration_ms INTEGER NOT NULL,
	streamed BOOLEAN NOT NULL,
	input_tokens INTEGER,
	output_tokens INTEGER,
	cache_read_tokens INTEGER,
	cache_write_tokens INTEGER,
	error TEXT
);
CREATE INDEX IF NOT EXISTS ix_billing_tenant_at ON billing_events (tenant, at DESC);
CREATE INDEX IF NOT EXISTS ix_billing_session_at ON billing_events (session, at DESC);`);
}

export async function recordBillingEvent(sql: PostgresClient, event: BillingEvent): Promise<void> {
	await sql`INSERT INTO billing_events
		(tenant, session, operation, provider, model, status, request_bytes, response_bytes, duration_ms, streamed,
		 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error)
		VALUES (
			${event.tenant}, ${event.session}, ${event.operation ?? null}, ${event.provider}, ${event.model ?? null},
			${event.status}, ${event.requestBytes}, ${event.responseBytes}, ${event.durationMs}, ${event.streamed},
			${event.usage?.inputTokens ?? null}, ${event.usage?.outputTokens ?? null},
			${event.usage?.cacheReadTokens ?? null}, ${event.usage?.cacheWriteTokens ?? null}, ${event.error ?? null}
		)`;
}
