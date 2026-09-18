import postgres from "postgres";
import type { PostgresClient } from "./types.ts";

export interface PostgresClientOptions {
	/** PostgreSQL connection URL, for example `postgres://user:password@host:5432/database`. */
	url: string;
	/**
	 * Schema that holds the session tables. It is placed alone on `search_path` for every
	 * connection, so the backend's unqualified table names resolve there. Defaults to the
	 * server's default search path.
	 */
	schema?: string;
	/** Maximum pooled connections. Defaults to 4. */
	max?: number;
	/** Reported as `application_name`. Defaults to the package name. */
	applicationName?: string;
}

/**
 * Parses `int8` columns into JavaScript numbers. Session sequence numbers and millisecond
 * timestamps are stored as `bigint` but the Storage contract exposes them as numbers.
 */
const BIGINT_AS_NUMBER: postgres.PostgresType<number> = {
	to: 20,
	from: [20],
	serialize: (value: number) => String(value),
	parse: (raw: string) => {
		const parsed = Number(raw);
		if (!Number.isSafeInteger(parsed))
			throw new RangeError(`PostgreSQL bigint ${raw} exceeds the safe integer range`);
		return parsed;
	},
};

/** Quote one identifier for `search_path`. */
export function quoteIdentifier(name: string): string {
	if (name.length === 0) throw new TypeError("Identifier must not be empty");
	return `"${name.replaceAll('"', '""')}"`;
}

/** Create a pooled client configured for the session backend. Call `end()` when done. */
export function createPostgresClient(options: PostgresClientOptions): PostgresClient {
	const connection: Record<string, string | number | boolean> = {
		application_name: options.applicationName ?? "pi-session-backend-postgres",
	};
	if (options.schema !== undefined) connection.search_path = quoteIdentifier(options.schema);
	const client = postgres(options.url, {
		max: options.max ?? 4,
		connection,
		types: { bigint: BIGINT_AS_NUMBER },
		// `CREATE ... IF NOT EXISTS` emits "already exists, skipping" notices on every schema apply.
		onnotice: () => {},
	});
	return client as unknown as PostgresClient;
}
