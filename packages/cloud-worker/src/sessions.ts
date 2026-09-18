import type { Context } from "@earendil-works/pi-agent-core";
import type { SessionSummary } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import {
	applyInitialSchema,
	createPostgresClient,
	createSchemaIfMissing,
	type PostgresClient,
	type PostgresSessionMetadata,
	type PostgresSessionRepo,
} from "@earendil-works/pi-session-backend-postgres";
import type { CloudConfig } from "./config.ts";

/** Every cloud session works in the sandbox's mounted workspace. */
export const WORKSPACE_CWD = "/workspace";

export function createSessionClient(config: CloudConfig, applicationName: string): PostgresClient {
	return createPostgresClient({ url: config.databaseUrl, schema: config.schema, max: 4, applicationName });
}

/** Create the schema and tables when they do not exist. Safe to run on every start. */
export async function ensureSessionSchema(sql: PostgresClient, config: CloudConfig): Promise<void> {
	await createSchemaIfMissing(sql, config.schema);
	await applyInitialSchema(sql);
}

/** Stable, human-readable location string for presentations that expect a session path. */
export function sessionLocation(config: CloudConfig, sessionId: string): string {
	return `postgres:${config.schema}/${sessionId}`;
}

export function toSessionSummary(config: CloudConfig, metadata: PostgresSessionMetadata): SessionSummary {
	return {
		id: metadata.id,
		path: sessionLocation(config, metadata.id),
		cwd: WORKSPACE_CWD,
		createdAt: metadata.createdAt,
	};
}

export async function listSessionSummaries(
	repo: PostgresSessionRepo,
	config: CloudConfig,
	context: Context,
): Promise<SessionSummary[]> {
	return (await repo.list(undefined, context)).map((metadata) => toSessionSummary(config, metadata));
}
