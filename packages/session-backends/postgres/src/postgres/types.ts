import type postgres from "postgres";

type PostgresTypes = Record<string, never>;

/** Pooled postgres.js client owned by the caller. */
export type PostgresClient = postgres.Sql<PostgresTypes>;

/** Transaction-scoped postgres.js handle produced by {@link PostgresClient.begin}. */
export type PostgresTransaction = postgres.TransactionSql<PostgresTypes>;

/** Any handle the backend can run queries through. */
export type PostgresQueryable = PostgresClient | PostgresTransaction;

/**
 * JSON parameters are written as `${JSON.stringify(value)}::text::json`, never `::json`.
 * postgres.js describes parameter types with the server and then serializes each value with
 * the serializer for the described type; a parameter cast straight to `json` would be
 * `JSON.stringify`ed a second time. Casting from `text` keeps the stringified value verbatim and
 * still stores a JSON `null` as the json value `null`, not SQL NULL.
 */
export type JsonParameterNote = never;
