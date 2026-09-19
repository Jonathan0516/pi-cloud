import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { socketTransport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { connect, listSessions } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import {
	createPostgresClient,
	expireSessionLease,
	PostgresSessionRepo,
	readSessionLease,
} from "@earendil-works/pi-session-backend-postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { CloudConfig } from "../src/config.ts";
import { type RunningCloudServer, startCloudServer } from "../src/server/run.ts";
import { WORKSPACE_CWD } from "../src/sessions.ts";

const databaseUrl = process.env.PI_TEST_PG_URL;
const sandboxDomain = process.env.OPEN_SANDBOX_DOMAIN;
const workspacesRoot = process.env.PI_WORKSPACES_ROOT;
const workerEnabled = process.env.PI_TEST_CLOUD_WORKER === "1";
const describeCloud = databaseUrl && sandboxDomain && workspacesRoot ? describe : describe.skip;

const schema = `pi_cloud_test_${randomUUID().replaceAll("-", "")}`;
const cleanups: Array<() => Promise<void>> = [];

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
	return {
		databaseUrl: databaseUrl!,
		schema,
		sandboxDomain: sandboxDomain!,
		...(process.env.OPEN_SANDBOX_API_KEY ? { sandboxApiKey: process.env.OPEN_SANDBOX_API_KEY } : {}),
		sandboxImage: process.env.PI_TEST_SANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0",
		sandboxTimeoutSeconds: 600,
		workspacesRoot: workspacesRoot!,
		bundleCacheDir: join(workspacesRoot ?? tmpdir(), ".bundles"),
		workspaceRetentionDays: 14,
		workspaceGcIntervalMs: 0,
		leaseTtlSeconds: 30,
		leaseHeartbeatMs: 5000,
		nodeId: `test-node-${randomUUID().slice(0, 8)}`,
		nodeListenHost: "127.0.0.1",
		nodeListenPort: 0,
		nodePersistent: true,
		reaperIntervalMs: 0,
		reaperTakeoversPerTick: 2,
		poisonThreshold: 3,
		workerIdleGraceMs: 60_000,
		...overrides,
	};
}

async function startNode(overrides: Partial<CloudConfig> = {}): Promise<RunningCloudServer> {
	const server = await startCloudServer({ config: config(overrides) });
	cleanups.push(async () => {
		server.stop();
		await server.done;
	});
	return server;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

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

describeCloud("cloud session server", () => {
	it("initializes the catalog and lists sessions from PostgreSQL", async () => {
		const socketDir = await mkdtemp(join(tmpdir(), "pi-cloud-"));
		cleanups.push(() => rm(socketDir, { recursive: true, force: true }));
		const transport = socketTransport(join(socketDir, "s.sock"));
		const server = await startCloudServer({ transport, config: config(), retireWhenIdle: false });
		cleanups.push(async () => {
			server.stop();
			await server.done;
		});

		expect(await listSessions(transport)).toEqual([]);

		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		try {
			const repo = new PostgresSessionRepo({ sql });
			const created = await repo.create({ id: "catalog-session" }, BACKGROUND_CONTEXT);
			await created.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		} finally {
			await sql.end();
		}
		expect(await listSessions(transport)).toMatchObject([
			{ id: "catalog-session", cwd: WORKSPACE_CWD, path: `postgres:${schema}/catalog-session` },
		]);
	});

	it.skipIf(!workerEnabled)("spawns a worker on attach and reattaches to the same session", async () => {
		const socketDir = await mkdtemp(join(tmpdir(), "pi-cloud-"));
		cleanups.push(() => rm(socketDir, { recursive: true, force: true }));
		const transport = socketTransport(join(socketDir, "s.sock"));
		const server = await startCloudServer({ transport, config: config(), retireWhenIdle: false });
		cleanups.push(async () => {
			server.stop();
			await server.done;
		});

		const first = await connect(transport, null, WORKSPACE_CWD);
		let state: ReturnType<typeof first.state>;
		try {
			state = first.state();
			expect(state.cwd).toBe(WORKSPACE_CWD);
			expect(state.lane.operation).toBeNull();
			expect(state.lane.transcript).toEqual([]);
		} finally {
			first.close();
		}

		const second = await connect(transport, state.sessionId, WORKSPACE_CWD);
		try {
			expect(second.state().sessionId).toBe(state.sessionId);
		} finally {
			second.close();
		}

		const listed = await listSessions(transport);
		expect(listed.map((session) => session.id)).toContain(state.sessionId);
	});

	it.skipIf(!workerEnabled)("takes a crashed worker's session over without waiting for the lease TTL", async () => {
		const socketDir = await mkdtemp(join(tmpdir(), "pi-cloud-"));
		cleanups.push(() => rm(socketDir, { recursive: true, force: true }));
		const transport = socketTransport(join(socketDir, "s.sock"));
		const server = await startCloudServer({ transport, config: config(), retireWhenIdle: false });
		cleanups.push(async () => {
			server.stop();
			await server.done;
		});
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());

		const first = await connect(transport, null, WORKSPACE_CWD);
		const sessionId = first.state().sessionId;
		const lease = await readSessionLease(sql, sessionId);
		expect(lease).toMatchObject({ state: "held", epoch: 1 });
		const pid = Number.parseInt(lease!.owner.proc.split(":")[0]!, 10);
		expect(execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })).toContain(
			"worker/entry.ts",
		);

		// The worker dies without releasing. The server saw it exit and expires the lease on its behalf.
		process.kill(pid, "SIGKILL");
		first.close();
		const started = Date.now();
		const second = await connect(transport, sessionId, WORKSPACE_CWD);
		try {
			expect(Date.now() - started).toBeLessThan(20_000);
			expect(second.state().sessionId).toBe(sessionId);
			expect(await readSessionLease(sql, sessionId)).toMatchObject({ state: "held", epoch: 2 });
		} finally {
			second.close();
		}
	});
});

describeCloud("cloud nodes", () => {
	it("serves presentations over TCP and advertises the bound port", async () => {
		const node = await startNode();
		expect(node.address).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(node.address).not.toBe("127.0.0.1:0");
		// The schema is shared with the other suites, so only the shape is checked.
		const listed = await listSessions(node.tcp);
		expect(listed.every((session) => session.cwd === WORKSPACE_CWD)).toBe(true);
	});

	it.skipIf(!workerEnabled)("relays a presentation to the node that owns the session", async () => {
		const nodeA = await startNode();
		const nodeB = await startNode();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());

		const viaA = await connect(nodeA.tcp, null, WORKSPACE_CWD);
		const sessionId = viaA.state().sessionId;
		expect(nodeA.localSessions()).toEqual([sessionId]);
		const lease = await readSessionLease(sql, sessionId);
		expect(lease).toMatchObject({ state: "held", owner: { node: nodeA.nodeId, addr: nodeA.address } });

		// B does not own the session, so it must not spawn a second worker; the lease says where to go.
		const viaB = await connect(nodeB.tcp, sessionId, WORKSPACE_CWD);
		try {
			expect(viaB.state().sessionId).toBe(sessionId);
			expect(viaB.state().lane.operation).toBeNull();
			expect(nodeB.localSessions()).toEqual([]);
			expect(await readSessionLease(sql, sessionId)).toMatchObject({ epoch: 1, owner: { node: nodeA.nodeId } });
		} finally {
			viaB.close();
			viaA.close();
		}
	});

	it.skipIf(!workerEnabled)("stops an unwatched idle worker after the grace period and frees the lease", async () => {
		const node = await startNode({ workerIdleGraceMs: 1_000 });
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());

		const client = await connect(node.tcp, null, WORKSPACE_CWD);
		const sessionId = client.state().sessionId;
		client.close();

		await waitFor(() => !node.localSessions().includes(sessionId), 30_000, "the idle worker to stop");
		await waitFor(
			async () => (await readSessionLease(sql, sessionId))?.state === "free",
			30_000,
			"the lease to free",
		);
	});

	it.skipIf(!workerEnabled)("reaps a session whose lease expired while an operation was open", async () => {
		const owner = await startNode();
		const sql = createPostgresClient({ url: databaseUrl!, schema, max: 1 });
		cleanups.push(() => sql.end());

		const client = await connect(owner.tcp, null, WORKSPACE_CWD);
		const sessionId = client.state().sessionId;
		const pid = Number.parseInt((await readSessionLease(sql, sessionId))!.owner.proc.split(":")[0]!, 10);
		// A dead node: its worker is gone, its lease still says held, and the session has an open operation.
		process.kill(pid, "SIGSTOP");
		await sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
			VALUES (${sessionId}, 'pi.op.state', 'op-1', 1, ${JSON.stringify({ status: "running" })}::text::json)`;
		expect(await expireSessionLease(sql, sessionId, 1)).toBe(true);
		client.close();
		process.kill(pid, "SIGKILL");
		// The owner's reaper is off, so only the reaping node can take the session.
		owner.stop();
		await owner.done;
		await sql`UPDATE session_leases SET state = 'held', expires_at = now() - interval '1 second' WHERE session_id = ${sessionId}`;

		const reaper = await startNode({ reaperIntervalMs: 500 });
		await waitFor(() => reaper.localSessions().includes(sessionId), 60_000, "the reaper to take the session over");
		expect(await readSessionLease(sql, sessionId)).toMatchObject({
			state: "held",
			epoch: 2,
			owner: { node: reaper.nodeId },
		});
	});
});
