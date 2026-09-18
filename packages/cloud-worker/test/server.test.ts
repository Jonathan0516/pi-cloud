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
	PostgresSessionRepo,
	readSessionLease,
} from "@earendil-works/pi-session-backend-postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { CloudConfig } from "../src/config.ts";
import { startCloudServer } from "../src/server/run.ts";
import { WORKSPACE_CWD } from "../src/sessions.ts";

const databaseUrl = process.env.PI_TEST_PG_URL;
const sandboxDomain = process.env.OPEN_SANDBOX_DOMAIN;
const workspacesRoot = process.env.PI_WORKSPACES_ROOT;
const workerEnabled = process.env.PI_TEST_CLOUD_WORKER === "1";
const describeCloud = databaseUrl && sandboxDomain && workspacesRoot ? describe : describe.skip;

const schema = `pi_cloud_test_${randomUUID().replaceAll("-", "")}`;
const cleanups: Array<() => Promise<void>> = [];

function config(): CloudConfig {
	return {
		databaseUrl: databaseUrl!,
		schema,
		sandboxDomain: sandboxDomain!,
		...(process.env.OPEN_SANDBOX_API_KEY ? { sandboxApiKey: process.env.OPEN_SANDBOX_API_KEY } : {}),
		sandboxImage: process.env.PI_TEST_SANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0",
		sandboxTimeoutSeconds: 600,
		workspacesRoot: workspacesRoot!,
		leaseTtlSeconds: 30,
		leaseHeartbeatMs: 5000,
	};
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
