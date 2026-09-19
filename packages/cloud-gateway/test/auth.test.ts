import { randomUUID } from "node:crypto";
import { createPostgresClient } from "@earendil-works/pi-session-backend-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	API_KEY_PREFIX,
	authenticateApiKey,
	bearerToken,
	createApiKey,
	ensureAuthSchema,
	generateApiKey,
	hashApiKey,
	installApiKey,
	listApiKeys,
	looksLikeApiKey,
	revokeApiKey,
} from "../src/auth.ts";
import { parseBootstrapKeys, parseNodes } from "../src/config.ts";
import { bearerFromProtocols, protocolsFor } from "../src/ws.ts";

const databaseUrl = process.env.PI_TEST_PG_URL;
const describePg = databaseUrl ? describe : describe.skip;
const schema = `pi_gw_auth_${randomUUID().replaceAll("-", "")}`;

describe("api key shapes", () => {
	it("generates prefixed, url-safe keys that pass the shape check", () => {
		const key = generateApiKey();
		expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
		expect(looksLikeApiKey(key)).toBe(true);
		expect(looksLikeApiKey("short")).toBe(false);
		expect(looksLikeApiKey(`${"a".repeat(30)} with space`)).toBe(false);
		expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reads bearer keys from the header and from the websocket subprotocol", () => {
		expect(bearerToken("Bearer abc")).toBe("abc");
		expect(bearerToken("bearer   abc ")).toBe("abc");
		expect(bearerToken("Basic abc")).toBeUndefined();
		expect(bearerFromProtocols(protocolsFor("k1").join(", "))).toBe("k1");
		expect(bearerFromProtocols("pi-cloud.v1")).toBeUndefined();
	});

	it("parses bootstrap keys and node lists", () => {
		const key = generateApiKey();
		expect(parseBootstrapKeys(`acme:alice:${key}`)).toEqual([{ tenant: "acme", user: "alice", key }]);
		expect(() => parseBootstrapKeys("acme:alice:short")).toThrow(/at least/);
		expect(() => parseBootstrapKeys("acme:alice")).toThrow(/tenant:user:key/);
		expect(parseNodes(" 10.0.0.1:7420, 10.0.0.2:7420 ")).toEqual(["10.0.0.1:7420", "10.0.0.2:7420"]);
		expect(() => parseNodes("nope")).toThrow(/host:port/);
	});
});

describePg("api key store", () => {
	const sql = createPostgresClient({ url: databaseUrl ?? "postgres://unused", schema, max: 2 });

	beforeAll(async () => {
		await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
		await ensureAuthSchema(sql);
	});

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
		await sql.end();
	});

	it("authenticates a created key until it is revoked and never stores the key itself", async () => {
		const { key, keyHash } = await createApiKey(sql, { tenant: "acme", user: "alice" }, "laptop");
		expect(await authenticateApiKey(sql, key)).toEqual({ tenant: "acme", user: "alice" });
		expect(await authenticateApiKey(sql, `${key}x`)).toBeUndefined();
		const rows = await sql<{ key_hash: string }[]>`SELECT key_hash FROM gateway_api_keys`;
		expect(rows.map((row) => row.key_hash)).toContain(keyHash);
		expect(rows.some((row) => row.key_hash.includes(key))).toBe(false);

		expect(await revokeApiKey(sql, keyHash)).toBe(true);
		expect(await revokeApiKey(sql, keyHash)).toBe(false);
		expect(await authenticateApiKey(sql, key)).toBeUndefined();
		expect((await listApiKeys(sql, "acme")).map((row) => [row.label, row.revokedAt !== null])).toEqual([
			["laptop", true],
		]);
	});

	it("installs bootstrap keys idempotently and keeps a revoked one revoked", async () => {
		const key = generateApiKey();
		await installApiKey(sql, key, { tenant: "boot", user: "root" });
		await installApiKey(sql, key, { tenant: "boot", user: "root" });
		expect(await authenticateApiKey(sql, key)).toEqual({ tenant: "boot", user: "root" });
		await revokeApiKey(sql, hashApiKey(key));
		await installApiKey(sql, key, { tenant: "boot", user: "root" });
		expect(await authenticateApiKey(sql, key)).toBeUndefined();
	});
});
