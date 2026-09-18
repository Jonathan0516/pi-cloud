import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPostgresClient, createSchemaIfMissing } from "@earendil-works/pi-session-backend-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type BillingEvent,
	type ModelProxyConfig,
	mintProxyToken,
	type RunningModelProxy,
	startModelProxy,
} from "../src/index.ts";

const SECRET = "test-secret-that-is-long-enough";
const TENANT = "acme";
const SESSION = "session-1";

interface SeenRequest {
	method: string;
	path: string;
	headers: IncomingMessage["headers"];
	body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: SeenRequest[] = [];
let mode: "json" | "sse" | "error" = "json";

beforeAll(async () => {
	upstream = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
		});
		req.on("end", () => {
			seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
			if (mode === "error") {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "boom" }));
				return;
			}
			if (mode === "sse") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(
					'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
				);
				setTimeout(() => {
					res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":8}}\n\n');
					res.end();
				}, 50);
				return;
			}
			res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
			res.end(JSON.stringify({ id: "msg", usage: { input_tokens: 3, output_tokens: 5 } }));
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
	upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function config(overrides: Partial<ModelProxyConfig> = {}): ModelProxyConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		secret: SECRET,
		upstreams: new Map([
			[
				"anthropic",
				{ provider: "anthropic", baseUrl: upstreamUrl, api: "anthropic-messages", authStyle: "x-api-key" },
			],
			[
				"deepseek",
				{ provider: "deepseek", baseUrl: `${upstreamUrl}/base`, api: "openai-completions", authStyle: "bearer" },
			],
			["nokey", { provider: "nokey", baseUrl: upstreamUrl, api: "openai-completions", authStyle: "bearer" }],
		]),
		keys: new Map([
			["anthropic", "sk-ant-real"],
			["deepseek", "sk-deepseek-real"],
		]),
		rateLimitPerMinute: 1000,
		maxRequestBytes: 1024 * 1024,
		maxUsageCaptureBytes: 1024 * 1024,
		...overrides,
	};
}

async function withProxy<T>(
	overrides: Partial<ModelProxyConfig>,
	run: (proxy: RunningModelProxy, events: BillingEvent[]) => Promise<T>,
): Promise<T> {
	const events: BillingEvent[] = [];
	const proxy = await startModelProxy(config(overrides), { onEvent: (event) => events.push(event) });
	try {
		return await run(proxy, events);
	} finally {
		await proxy.close();
	}
}

function token(claims: { tenant?: string; session?: string } = {}, ttl = 60): string {
	return mintProxyToken(SECRET, { tenant: claims.tenant ?? TENANT, session: claims.session ?? SESSION }, ttl);
}

describe("model proxy", () => {
	it("swaps the token for the vendor key and forwards the path, query, and body", async () => {
		mode = "json";
		seen.length = 0;
		await withProxy({}, async (proxy, events) => {
			const response = await fetch(`${proxy.url}/v1/deepseek/chat/completions?beta=1&key=leak`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token()}`,
					"content-type": "application/json",
					"x-pi-session": SESSION,
					"x-pi-operation": "op-1",
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({ model: "deepseek-v4-pro", messages: [] }),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("x-upstream")).toBe("yes");
			expect(await response.json()).toMatchObject({ id: "msg" });

			expect(seen).toHaveLength(1);
			const request = seen[0]!;
			expect(request.path).toBe("/base/chat/completions?beta=1");
			expect(request.headers.authorization).toBe("Bearer sk-deepseek-real");
			expect(request.headers["x-pi-session"]).toBeUndefined();
			expect(request.headers["x-pi-operation"]).toBeUndefined();
			expect(request.headers["anthropic-version"]).toBe("2023-06-01");
			expect(JSON.stringify(request.headers)).not.toContain("pimp1.");
			expect(request.body).toContain("deepseek-v4-pro");

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				tenant: TENANT,
				session: SESSION,
				operation: "op-1",
				provider: "deepseek",
				model: "deepseek-v4-pro",
				status: 200,
				streamed: false,
				usage: { inputTokens: 3, outputTokens: 5 },
			});
		});
	});

	it("injects x-api-key for Anthropic and meters streamed usage", async () => {
		mode = "sse";
		seen.length = 0;
		await withProxy({}, async (proxy, events) => {
			const response = await fetch(`${proxy.url}/v1/anthropic/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": token(), "content-type": "application/json", "x-pi-session": SESSION },
				body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true }),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/event-stream");
			const text = await response.text();
			expect(text).toContain("message_start");
			expect(text).toContain("message_delta");
			expect(seen[0]!.headers["x-api-key"]).toBe("sk-ant-real");
			expect(seen[0]!.headers.authorization).toBeUndefined();
			expect(events[0]).toMatchObject({
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				streamed: true,
				usage: { inputTokens: 12, outputTokens: 8 },
			});
		});
	});

	it("refuses missing, invalid, expired, and mis-bound tokens without touching the upstream", async () => {
		mode = "json";
		seen.length = 0;
		await withProxy({}, async (proxy) => {
			const post = (headers: Record<string, string>) =>
				fetch(`${proxy.url}/v1/deepseek/chat/completions`, { method: "POST", headers, body: "{}" });
			expect((await post({})).status).toBe(401);
			expect((await post({ authorization: "Bearer sk-vendor-key-leaked-by-worker" })).status).toBe(401);
			expect((await post({ authorization: `Bearer ${token({}, -10)}` })).status).toBe(401);
			expect((await post({ authorization: `Bearer ${token()}`, "x-pi-session": "another" })).status).toBe(403);
			expect(
				(await fetch(`${proxy.url}/v1/unknown/x`, { headers: { authorization: `Bearer ${token()}` } })).status,
			).toBe(404);
			expect(seen).toHaveLength(0);
		});
	});

	it("refuses providers without a key, disallowed models, and over-limit tenants", async () => {
		mode = "json";
		seen.length = 0;
		await withProxy({ allowModels: ["deepseek/deepseek-*"], rateLimitPerMinute: 2 }, async (proxy, events) => {
			const post = (provider: string, model: string) =>
				fetch(`${proxy.url}/v1/${provider}/chat/completions`, {
					method: "POST",
					headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
					body: JSON.stringify({ model }),
				});
			expect((await post("nokey", "x")).status).toBe(502);
			expect((await post("deepseek", "other-model")).status).toBe(403);
			expect((await post("deepseek", "deepseek-v4-pro")).status).toBe(429);
			expect(seen).toHaveLength(0);
			expect(events).toHaveLength(0);
		});
	});

	it("reports upstream failures with their status and records the event", async () => {
		mode = "error";
		seen.length = 0;
		await withProxy({}, async (proxy, events) => {
			const response = await fetch(`${proxy.url}/v1/deepseek/chat/completions`, {
				method: "POST",
				headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
				body: JSON.stringify({ model: "deepseek-v4-pro" }),
			});
			expect(response.status).toBe(500);
			expect(await response.json()).toEqual({ error: "boom" });
			expect(events[0]).toMatchObject({ status: 500, provider: "deepseek" });
		});
	});

	it("answers health checks without a token", async () => {
		await withProxy({}, async (proxy) => {
			const response = await fetch(`${proxy.url}/healthz`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true, providers: ["anthropic", "deepseek"] });
		});
	});
});

const databaseUrl = process.env.PI_TEST_PG_URL;
(databaseUrl ? describe : describe.skip)("model proxy billing", () => {
	it("writes one billing_events row per call", async () => {
		mode = "json";
		const schema = `pi_proxy_test_${randomUUID().replaceAll("-", "")}`;
		const admin = createPostgresClient({ url: databaseUrl!, max: 1 });
		await createSchemaIfMissing(admin, schema);
		try {
			await withProxy({ billing: { url: databaseUrl!, schema } }, async (proxy) => {
				const response = await fetch(`${proxy.url}/v1/deepseek/chat/completions`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token()}`,
						"content-type": "application/json",
						"x-pi-operation": "op-9",
					},
					body: JSON.stringify({ model: "deepseek-v4-pro" }),
				});
				expect(response.status).toBe(200);
			});
			const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
			try {
				const rows = await sql<
					{
						tenant: string;
						session: string;
						operation: string;
						provider: string;
						model: string;
						status: number;
						input_tokens: number;
						output_tokens: number;
					}[]
				>`SELECT tenant, session, operation, provider, model, status, input_tokens, output_tokens FROM billing_events`;
				expect(rows).toEqual([
					{
						tenant: TENANT,
						session: SESSION,
						operation: "op-9",
						provider: "deepseek",
						model: "deepseek-v4-pro",
						status: 200,
						input_tokens: 3,
						output_tokens: 5,
					},
				]);
			} finally {
				await sql.end();
			}
		} finally {
			await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await admin.end();
		}
	});
});
