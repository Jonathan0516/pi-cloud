import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { quoteIdentifier } from "./client.ts";
import type { PostgresQueryable } from "./types.ts";

/** Ordered migration files. Every statement is idempotent, so applying them again is safe. */
const MIGRATIONS = ["001_initial.sql", "002_session_leases.sql"] as const;

/** Create the schema named by `schema` when it does not exist yet. */
export async function createSchemaIfMissing(sql: PostgresQueryable, schema: string): Promise<void> {
	await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
}

/** Create the session tables on the connection's current `search_path`. Idempotent. */
export async function applyInitialSchema(sql: PostgresQueryable): Promise<void> {
	for (const name of MIGRATIONS) {
		const migration = await readFile(fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)), "utf8");
		await sql.unsafe(migration);
	}
}
