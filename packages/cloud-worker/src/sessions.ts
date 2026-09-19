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
import { ensureBundleSchema } from "./bundles/store.ts";
import type { CloudConfig } from "./config.ts";
import { ensureRecoverySchema } from "./server/recovery.ts";

/** Every cloud session works in the sandbox's mounted workspace. */
export const WORKSPACE_CWD = "/workspace";

export function createSessionClient(config: CloudConfig, applicationName: string): PostgresClient {
	return createPostgresClient({ url: config.databaseUrl, schema: config.schema, max: 4, applicationName });
}

/** Create the schema and tables when they do not exist. Safe to run on every start. */
/**
 * Create the schema and every table this node needs. Nodes start together after a deploy, and
 * concurrent `CREATE ... IF NOT EXISTS` statements race inside PostgreSQL (duplicate `pg_type`
 * rows), so the whole setup runs under one advisory lock keyed by the schema name.
 */
export async function ensureSessionSchema(sql: PostgresClient, config: Pick<CloudConfig, "schema">): Promise<void> {
	await sql.begin(async (transaction) => {
		await transaction`SELECT pg_advisory_xact_lock(hashtext(${`pi-cloud-schema:${config.schema}`}))`;
		await createSchemaIfMissing(transaction, config.schema);
		await applyInitialSchema(transaction);
		await ensureRecoverySchema(transaction);
		await ensureBundleSchema(transaction);
	});
}

/** Stable, human-readable location string for presentations that expect a session path. */
export function sessionLocation(config: Pick<CloudConfig, "schema">, sessionId: string): string {
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
