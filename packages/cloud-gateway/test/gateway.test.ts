import { randomUUID } from "node:crypto";
import { type CloudConfig, startCloudServer, WORKSPACE_CWD } from "@earendil-works/pi-cloud-worker";
import { connect, listSessions } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import { createPostgresClient } from "@earendil-works/pi-session-backend-postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createApiKey } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { startGateway } from "../src/server.ts";
import { webSocketTransport } from "../src/ws.ts";

const databaseUrl = process.env.PI_TEST_PG_URL;
const sandboxDomain = process.env.OPEN_SANDBOX_DOMAIN;
const workspacesRoot = process.env.PI_WORKSPACES_ROOT;
const workerEnabled = process.env.PI_TEST_CLOUD_WORKER === "1";
const describePg = databaseUrl ? describe : describe.skip;
const describeCloud = databaseUrl && sandboxDomain && workspacesRoot ? describe : describe.skip;

const schema = `pi_gw_test_${randomUUID().replaceAll("-", "")}`;
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
	if (!databaseUrl) return;
	const admin = createPostgresClient({ url: databaseUrl, max: 1 });
	try {
		await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	} finally {
		await admin.end();
	}
});

function nodeConfig(): CloudConfig {
	return {
		databaseUrl: databaseUrl!,
		schema,
		sandboxDomain: sandboxDomain ?? "127.0.0.1:1",
		...(process.env.OPEN_SANDBOX_API_KEY ? { sandboxApiKey: process.env.OPEN_SANDBOX_API_KEY } : {}),
		sandboxImage: process.env.PI_TEST_SANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0",
		sandboxTimeoutSeconds: 600,
		workspacesRoot: workspacesRoot ?? "/tmp",
		bundleCacheDir: `${workspacesRoot ?? "/tmp"}/.bundles`,
		workspaceRetentionDays: 14,
		workspaceGcIntervalMs: 0,
		leaseTtlSeconds: 30,
		leaseHeartbeatMs: 5000,
		nodeId: `gw-test-node-${randomUUID().slice(0, 8)}`,
		nodeListenHost: "127.0.0.1",
		nodeListenPort: 0,
		nodePersistent: true,
		reaperIntervalMs: 0,
		reaperTakeoversPerTick: 2,
		poisonThreshold: 3,
		workerIdleGraceMs: 60_000,
	};
}

function gatewayConfig(nodes: string[]): GatewayConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		databaseUrl: databaseUrl!,
		schema,
		nodes,
		nodeConnectTimeoutMs: 2000,
		bootstrapKeys: [],
	};
}

async function startStack(): Promise<{ gatewayUrl: string; wsUrl: string; nodeAddress: string }> {
	const node = await startCloudServer({ config: nodeConfig() });
	cleanups.push(async () => {
		node.stop();
		await node.done;
	});
	const gateway = await startGateway(gatewayConfig([node.address]), { log: () => undefined });
	cleanups.push(() => gateway.close());
	return { gatewayUrl: gateway.url, wsUrl: `ws://127.0.0.1:${gateway.port}/v1/ws`, nodeAddress: node.address };
}

async function api(url: string, key: string | undefined, init: RequestInit = {}): Promise<Response> {
	return fetch(url, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...init.headers } });
}

describePg("gateway REST", () => {
	it("scopes the session catalog to the caller's tenant", async () => {
		const { gatewayUrl } = await startStack();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());
		const acme = (await createApiKey(sql, { tenant: "acme", user: "alice" })).key;
		const globex = (await createApiKey(sql, { tenant: "globex", user: "bob" })).key;

		expect((await fetch(`${gatewayUrl}/healthz`)).status).toBe(200);
		expect((await api(`${gatewayUrl}/v1/sessions`, undefined)).status).toBe(401);
		expect((await api(`${gatewayUrl}/v1/sessions`, "pik_not-a-real-key-at-all-000000")).status).toBe(401);
		expect(await (await api(`${gatewayUrl}/v1/me`, acme)).json()).toEqual({ tenant: "acme", user: "alice" });

		const created = await api(`${gatewayUrl}/v1/sessions`, acme, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "first" }),
		});
		expect(created.status).toBe(201);
		const session = (await created.json()) as { id: string; state: string; title: string; cwd: string; owner: null };
		expect(session).toMatchObject({
			tenant: "acme",
			user: "alice",
			title: "first",
			state: "idle",
			cwd: WORKSPACE_CWD,
			owner: null,
		});

		const mine = (await (await api(`${gatewayUrl}/v1/sessions`, acme)).json()) as { sessions: { id: string }[] };
		expect(mine.sessions.map((entry) => entry.id)).toEqual([session.id]);
		const theirs = (await (await api(`${gatewayUrl}/v1/sessions`, globex)).json()) as { sessions: unknown[] };
		expect(theirs.sessions).toEqual([]);
		expect((await api(`${gatewayUrl}/v1/sessions/${session.id}`, globex)).status).toBe(404);
		expect((await api(`${gatewayUrl}/v1/sessions/${session.id}`, globex, { method: "DELETE" })).status).toBe(404);
		expect((await api(`${gatewayUrl}/v1/sessions/${session.id}`, acme)).status).toBe(200);

		expect((await api(`${gatewayUrl}/v1/sessions/${session.id}`, acme, { method: "DELETE" })).status).toBe(204);
		expect((await api(`${gatewayUrl}/v1/sessions/${session.id}`, acme)).status).toBe(404);
		expect((await sql`SELECT 1 FROM sessions WHERE id = ${session.id}`).length).toBe(0);
	});

	it("rejects oversized and malformed bodies", async () => {
		const { gatewayUrl } = await startStack();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());
		const key = (await createApiKey(sql, { tenant: "acme", user: "alice" })).key;
		expect((await api(`${gatewayUrl}/v1/sessions`, key, { method: "POST", body: "not json" })).status).toBe(400);
		expect(
			(await api(`${gatewayUrl}/v1/sessions`, key, { method: "POST", body: JSON.stringify({ title: 42 }) })).status,
		).toBe(400);
		expect((await api(`${gatewayUrl}/v1/sessions`, key, { method: "PUT" })).status).toBe(405);
		expect((await api(`${gatewayUrl}/v1/nope`, key)).status).toBe(404);
	});
});

describeCloud("gateway WebSocket", () => {
	it("refuses an upgrade without a valid key", async () => {
		const { wsUrl } = await startStack();
		await expect(webSocketTransport(wsUrl, "pik_not-a-real-key-at-all-000000").connect()).rejects.toThrow();
	});

	it("answers sessions.list per tenant over the websocket without touching a node", async () => {
		const { gatewayUrl, wsUrl } = await startStack();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());
		const acme = (await createApiKey(sql, { tenant: "acme", user: "alice" })).key;
		const globex = (await createApiKey(sql, { tenant: "globex", user: "bob" })).key;
		const created = (await (
			await api(`${gatewayUrl}/v1/sessions`, acme, { method: "POST", body: JSON.stringify({}) })
		).json()) as { id: string };

		const acmeList = await listSessions(webSocketTransport(wsUrl, acme));
		expect(acmeList.map((session) => session.id)).toContain(created.id);
		const globexList = await listSessions(webSocketTransport(wsUrl, globex));
		expect(globexList.map((session) => session.id)).not.toContain(created.id);
	});

	it.skipIf(!workerEnabled)("relays an attached presentation to the node and blocks other tenants", async () => {
		const { gatewayUrl, wsUrl } = await startStack();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());
		const acme = (await createApiKey(sql, { tenant: "acme", user: "alice" })).key;
		const globex = (await createApiKey(sql, { tenant: "globex", user: "bob" })).key;

		// A new session through the websocket lands in the caller's catalog.
		const fresh = await connect(webSocketTransport(wsUrl, acme), null, WORKSPACE_CWD);
		const sessionId = fresh.state().sessionId;
		try {
			expect(fresh.state().cwd).toBe(WORKSPACE_CWD);
			expect(fresh.state().lane.operation).toBeNull();
			const view = (await (await api(`${gatewayUrl}/v1/sessions/${sessionId}`, acme)).json()) as {
				state: string;
				owner: { node: string } | null;
			};
			expect(view.state).toBe("running");
			expect(view.owner).not.toBeNull();
			// Deleting a running session is refused.
			expect((await api(`${gatewayUrl}/v1/sessions/${sessionId}`, acme, { method: "DELETE" })).status).toBe(409);
		} finally {
			fresh.close();
		}

		// Another tenant cannot attach to it, even knowing the id.
		await expect(connect(webSocketTransport(wsUrl, globex), sessionId, WORKSPACE_CWD)).rejects.toThrow(
			/Unknown session/,
		);

		// The owner reattaches to the same running worker.
		const again = await connect(webSocketTransport(wsUrl, acme), sessionId, WORKSPACE_CWD);
		try {
			expect(again.state().sessionId).toBe(sessionId);
		} finally {
			again.close();
		}
	});
});

describePg("gateway bundles", () => {
	async function tenantStack(): Promise<{ gatewayUrl: string; acme: string; globex: string }> {
		const { gatewayUrl } = await startStack();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());
		return {
			gatewayUrl,
			acme: (await createApiKey(sql, { tenant: "acme", user: "alice" })).key,
			globex: (await createApiKey(sql, { tenant: "globex", user: "bob" })).key,
		};
	}

	const files = {
		"SYSTEM.md": "You are the acme agent.",
		"skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy the service\n---\nRun make deploy.",
		"prompts/review.md": "---\ndescription: Review a file\n---\nReview $1.",
	};

	it("publishes a content-addressed bundle, lists it, and keeps it inside the tenant", async () => {
		const { gatewayUrl, acme, globex } = await tenantStack();
		const publish = async (key: string, body: unknown): Promise<Response> =>
			api(`${gatewayUrl}/v1/bundles`, key, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		const created = await publish(acme, { files });
		expect(created.status).toBe(201);
		const bundle = (await created.json()) as {
			version: string;
			created: boolean;
			files: { path: string }[];
			registers: { entryTypes: string[] };
		};
		expect(bundle.version).toMatch(/^[0-9a-f]{64}$/);
		expect(bundle.created).toBe(true);
		expect(bundle.files.map((entry) => entry.path)).toEqual(Object.keys(files).sort());
		expect(bundle.registers.entryTypes).toContain("message");

		// The same bytes are the same version: publishing twice stores nothing new.
		const again = (await publish(acme, { files })) as Response;
		expect(again.status).toBe(200);
		expect((await again.json()) as { version: string; created: boolean }).toMatchObject({
			version: bundle.version,
			created: false,
		});

		const listed = (await (await api(`${gatewayUrl}/v1/bundles`, acme)).json()) as { bundles: { version: string }[] };
		expect(listed.bundles.map((entry) => entry.version)).toContain(bundle.version);
		expect(
			((await (await api(`${gatewayUrl}/v1/bundles`, globex)).json()) as { bundles: unknown[] }).bundles,
		).toEqual([]);
		expect((await api(`${gatewayUrl}/v1/bundles/${bundle.version}`, globex)).status).toBe(404);
		expect((await api(`${gatewayUrl}/v1/bundles/not-a-version`, acme)).status).toBe(404);
		expect((await publish(acme, { files: { "../escape.md": "x" } })).status).toBe(400);
		expect((await publish(acme, { files: { "a.md": 42 } })).status).toBe(400);
	});

	it("pins new sessions to the tenant default and only to the tenant's own bundles", async () => {
		const { gatewayUrl, acme, globex } = await tenantStack();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());
		const bundle = (await (
			await api(`${gatewayUrl}/v1/bundles`, acme, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ files, setDefault: true }),
			})
		).json()) as { version: string };

		expect(((await (await api(`${gatewayUrl}/v1/tenant/bundle`, acme)).json()) as { version: string }).version).toBe(
			bundle.version,
		);
		expect((await api(`${gatewayUrl}/v1/tenant/bundle`, globex)).status).toBe(404);
		// Another tenant cannot adopt a bundle it does not own, even knowing its version.
		expect(
			(
				await api(`${gatewayUrl}/v1/tenant/bundle`, globex, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ version: bundle.version }),
				})
			).status,
		).toBe(404);

		const session = (await (
			await api(`${gatewayUrl}/v1/sessions`, acme, { method: "POST", body: JSON.stringify({}) })
		).json()) as { id: string };
		const values = await sql<
			{ namespace: string; value: string }[]
		>`SELECT namespace, value::text AS value FROM scalar_values
			WHERE session_id = ${session.id} AND namespace IN ('cloud.tenant', 'cloud.bundle') ORDER BY namespace`;
		expect(values.map((row) => [row.namespace, JSON.parse(row.value)])).toEqual([
			["cloud.bundle", bundle.version],
			["cloud.tenant", "acme"],
		]);

		expect((await api(`${gatewayUrl}/v1/tenant/bundle`, acme, { method: "DELETE" })).status).toBe(204);
		expect((await api(`${gatewayUrl}/v1/tenant/bundle`, acme)).status).toBe(404);
		const bare = (await (
			await api(`${gatewayUrl}/v1/sessions`, acme, { method: "POST", body: JSON.stringify({}) })
		).json()) as { id: string };
		const bareValues =
			await sql`SELECT namespace FROM scalar_values WHERE session_id = ${bare.id} AND namespace = 'cloud.bundle'`;
		expect(bareValues.length).toBe(0);
	});
});
