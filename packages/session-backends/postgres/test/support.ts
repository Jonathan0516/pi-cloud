import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { applyInitialSchema, createPostgresClient, createSchemaIfMissing, type PostgresClient } from "../src/index.ts";

/** Connection URL for a disposable PostgreSQL database. Tests skip when unset. */
export const TEST_DATABASE_URL = process.env.PI_TEST_PG_URL;

/** `describe` when a test database is configured, otherwise `describe.skip`. */
export const describePostgres = TEST_DATABASE_URL === undefined ? describe.skip : describe;

export interface TestSchema extends AsyncDisposable {
	readonly schema: string;
	readonly sql: PostgresClient;
}

function requireUrl(): string {
	if (TEST_DATABASE_URL === undefined) throw new Error("PI_TEST_PG_URL is not set");
	return TEST_DATABASE_URL;
}

async function withAdminClient(run: (sql: PostgresClient) => Promise<void>): Promise<void> {
	const admin = createPostgresClient({ url: requireUrl(), max: 1, applicationName: "pi-postgres-test-admin" });
	try {
		await run(admin);
	} finally {
		await admin.end();
	}
}

async function dropSchema(schema: string): Promise<void> {
	await withAdminClient(async (admin) => {
		await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	});
}

/** Create one throwaway schema with the session tables and a client whose search_path resolves it. */
export async function createTestSchema(): Promise<TestSchema> {
	const schema = `pi_test_${randomUUID().replaceAll("-", "")}`;
	await withAdminClient((admin) => createSchemaIfMissing(admin, schema));
	const sql = createPostgresClient({ url: requireUrl(), schema, max: 3, applicationName: "pi-postgres-test" });
	try {
		await applyInitialSchema(sql);
	} catch (error) {
		await sql.end();
		await dropSchema(schema);
		throw error;
	}
	return {
		schema,
		sql,
		async [Symbol.asyncDispose]() {
			try {
				await sql.end();
			} finally {
				await dropSchema(schema);
			}
		},
	};
}
