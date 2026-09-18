import {
	type ListElement,
	type ListReadOptions,
	resolveListReadOptions,
	type StoredValue,
	type Value,
	type ValueList,
	value,
} from "@earendil-works/pi-agent-core";
import type { PostgresQueryable } from "../types.ts";

export interface ScalarValueRow {
	namespace: string;
	key: string;
	seq: number;
	/** JSON column, already parsed by the client. */
	value: unknown;
}

export interface ListValueRow {
	seq: number;
	value: unknown;
}

export async function setScalarValueRow(
	sql: PostgresQueryable,
	sessionId: string,
	namespace: string,
	key: string,
	seq: number,
	storedValue: unknown,
): Promise<void> {
	await sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(storedValue)}::text::json)
		ON CONFLICT (session_id, namespace, key) DO UPDATE SET seq = EXCLUDED.seq, value = EXCLUDED.value`;
}

export async function deleteScalarValueRow(
	sql: PostgresQueryable,
	sessionId: string,
	namespace: string,
	key: string,
): Promise<void> {
	await sql`DELETE FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`;
}

export async function appendListValueRow(
	sql: PostgresQueryable,
	sessionId: string,
	namespace: string,
	key: string,
	seq: number,
	element: unknown,
): Promise<void> {
	await sql`INSERT INTO list_values (session_id, namespace, key, seq, value)
		VALUES (${sessionId}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(element)}::text::json)`;
}

export async function deleteListValueRows(
	sql: PostgresQueryable,
	sessionId: string,
	namespace: string,
	key: string,
): Promise<void> {
	await sql`DELETE FROM list_values
		WHERE session_id = ${sessionId} AND namespace = ${namespace} AND key = ${key}`;
}

function decodeScalarValueRow<T>(address: Value<T>, row: ScalarValueRow): StoredValue<T> {
	if (row.namespace !== address.namespace || row.key !== address.key) {
		throw new Error(`Expected value ${address.namespace}:${address.key}, found ${row.namespace}:${row.key}`);
	}
	return { address, seq: row.seq, value: row.value as T };
}

export async function readScalarValueRow<T>(
	sql: PostgresQueryable,
	sessionId: string,
	address: Value<T>,
): Promise<StoredValue<T> | undefined> {
	const [row] = await sql<ScalarValueRow[]>`SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}`;
	return row === undefined ? undefined : decodeScalarValueRow(address, row);
}

export async function readAllScalarValueRows(
	sql: PostgresQueryable,
	sessionId: string,
): Promise<StoredValue<unknown>[]> {
	const rows = await sql<ScalarValueRow[]>`SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId} ORDER BY seq ASC`;
	return rows.map((row) => ({
		address: value<unknown>(row.namespace, row.key),
		seq: row.seq,
		value: row.value,
	}));
}

/** Smallest string greater than every string with `prefix`, or undefined when no bound exists. */
export function nextPrefixBoundary(prefix: string): string | undefined {
	if (prefix === "") return undefined;
	const codePoints = Array.from(prefix);
	for (let index = codePoints.length - 1; index >= 0; index--) {
		const codePoint = codePoints[index]?.codePointAt(0);
		if (codePoint === undefined) throw new Error("Invalid value key prefix");
		if (codePoint < 0x10ffff) {
			const nextCodePoint = codePoint >= 0xd7ff && codePoint < 0xe000 ? 0xe000 : codePoint + 1;
			return `${codePoints.slice(0, index).join("")}${String.fromCodePoint(nextCodePoint)}`;
		}
	}
	return undefined;
}

export async function scanScalarValueRows<T>(
	sql: PostgresQueryable,
	sessionId: string,
	prefix: Value<T>,
): Promise<StoredValue<T>[]> {
	const upperBound = nextPrefixBoundary(prefix.key);
	const rows = await sql<ScalarValueRow[]>`SELECT namespace, key, seq, value FROM scalar_values
		WHERE session_id = ${sessionId}
			AND namespace = ${prefix.namespace}
			AND key >= ${prefix.key}
			${upperBound === undefined ? sql`` : sql`AND key < ${upperBound}`}
		ORDER BY key ASC`;
	return rows.map((row) => decodeScalarValueRow(value<T>(row.namespace, row.key), row));
}

export async function readListValueRows<T>(
	sql: PostgresQueryable,
	sessionId: string,
	address: ValueList<T>,
	options?: ListReadOptions,
): Promise<ListElement<T>[]> {
	const resolved = resolveListReadOptions(options);
	const ascending = resolved.order === "asc";
	const rows = await sql<ListValueRow[]>`SELECT seq, value FROM list_values
		WHERE session_id = ${sessionId} AND namespace = ${address.namespace} AND key = ${address.key}
			${
				resolved.cursor === undefined
					? sql``
					: ascending
						? sql`AND seq > ${resolved.cursor.seq}`
						: sql`AND seq < ${resolved.cursor.seq}`
			}
		${ascending ? sql`ORDER BY seq ASC` : sql`ORDER BY seq DESC`}
		LIMIT ${resolved.limit}`;
	return rows.map((row) => ({ seq: row.seq, value: row.value as T }));
}
