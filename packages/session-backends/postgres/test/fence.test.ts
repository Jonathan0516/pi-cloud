import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import {
	FencedError,
	type PostgresSessionLeaseOptions,
	PostgresSessionRepo,
	readSessionLease,
	releaseSessionLease,
	SessionLeaseHeldError,
} from "../src/index.ts";
import { createTestSchema, describePostgres, TEST_DATABASE_URL } from "./support.ts";

const A = { node: "node-a", addr: "10.0.0.1:7000", proc: "100:boot" };
const B = { node: "node-b", addr: "10.0.0.2:7000", proc: "200:boot" };
const counter = value<number>("test.fence", "counter");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function leased(
	owner: PostgresSessionLeaseOptions["owner"],
	overrides: Partial<PostgresSessionLeaseOptions> = {},
): PostgresSessionLeaseOptions {
	return { owner, ttlSeconds: 30, heartbeatIntervalMs: 0, ...overrides };
}

describePostgres("lease fencing", () => {
	it("refuses to open a session another live process holds", async () => {
		await using schema = await createTestSchema();
		const a = new PostgresSessionRepo({ sql: schema.sql, lease: leased(A) });
		const b = new PostgresSessionRepo({ sql: schema.sql, lease: leased(B) });
		const session = await a.create({ id: "s" }, BACKGROUND_CONTEXT);
		expect(session.lease).toMatchObject({ epoch: 1, predecessor: "none", owner: A });

		const attempt = b.open(session.metadata, BACKGROUND_CONTEXT);
		await expect(attempt).rejects.toBeInstanceOf(SessionLeaseHeldError);
		await attempt.catch((error: SessionLeaseHeldError) => {
			expect(error.holder.owner).toEqual(A);
			expect(error.holder.epoch).toBe(1);
		});
		await expect(b.delete(session.metadata, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(SessionLeaseHeldError);

		await session.close(BACKGROUND_CONTEXT);
		expect(await readSessionLease(schema.sql, "s")).toMatchObject({ state: "free", epoch: 1 });
		const reopened = await b.open(session.metadata, BACKGROUND_CONTEXT);
		expect(reopened.lease).toMatchObject({ epoch: 2, predecessor: "released", owner: B });
		await reopened.close(BACKGROUND_CONTEXT);
		await Promise.all([a.close(BACKGROUND_CONTEXT), b.close(BACKGROUND_CONTEXT)]);
	});

	it("takes over a stalled holder and rejects its later commits inside the commit transaction", async () => {
		await using schema = await createTestSchema();
		const fencedIds: string[] = [];
		// Repo A never heartbeats: from the database's point of view it is a process stuck in a GC pause.
		const a = new PostgresSessionRepo({
			sql: schema.sql,
			lease: leased(A, { ttlSeconds: 1, onFenced: (sessionId) => fencedIds.push(sessionId) }),
		});
		const b = new PostgresSessionRepo({ sql: schema.sql, lease: leased(B) });
		const stalled = await a.create({ id: "s" }, BACKGROUND_CONTEXT);
		await stalled.mutate((mutator) => mutator.commit([setValue(counter, 1)], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);

		await sleep(1_300);
		const takeover = await b.open(stalled.metadata, BACKGROUND_CONTEXT);
		expect(takeover.lease).toMatchObject({ epoch: 2, predecessor: "expired", owner: B });
		expect((await takeover.getValue(counter, BACKGROUND_CONTEXT))?.value).toBe(1);

		const staleCommit = stalled.mutate(
			(mutator) => mutator.commit([setValue(counter, 2)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		await expect(staleCommit).rejects.toBeInstanceOf(FencedError);
		expect(fencedIds).toEqual(["s"]);
		// Fenced storage fails fast without touching the database again.
		await expect(
			stalled.mutate((mutator) => mutator.commit([setValue(counter, 3)], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT),
		).rejects.toBeInstanceOf(FencedError);
		expect(fencedIds).toEqual(["s"]);

		await takeover.mutate(
			(mutator) => mutator.commit([setValue(counter, 10)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		expect((await takeover.getValue(counter, BACKGROUND_CONTEXT))?.value).toBe(10);

		// Closing the fenced session must not disturb the new owner's lease.
		await stalled.close(BACKGROUND_CONTEXT);
		expect(await readSessionLease(schema.sql, "s")).toMatchObject({ state: "held", epoch: 2, owner: B });
		await takeover.close(BACKGROUND_CONTEXT);
		expect(await readSessionLease(schema.sql, "s")).toMatchObject({ state: "free", epoch: 2 });
		await Promise.all([a.close(BACKGROUND_CONTEXT), b.close(BACKGROUND_CONTEXT)]);
	});

	it("keeps idle sessions alive by heartbeat and fences them when the heartbeat loses the lease", async () => {
		await using schema = await createTestSchema();
		const fencedIds: string[] = [];
		const a = new PostgresSessionRepo({
			sql: schema.sql,
			lease: leased(A, {
				ttlSeconds: 1,
				heartbeatIntervalMs: 200,
				onFenced: (sessionId) => fencedIds.push(sessionId),
			}),
		});
		const b = new PostgresSessionRepo({ sql: schema.sql, lease: leased(B) });
		const session = await a.create({ id: "s" }, BACKGROUND_CONTEXT);

		await sleep(1_500);
		await expect(b.open(session.metadata, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(SessionLeaseHeldError);
		expect(fencedIds).toEqual([]);

		// An operator releases the lease out from under the worker; the next heartbeat notices.
		expect(await releaseSessionLease(schema.sql, "s", 1)).toBe(true);
		const taken = await b.open(session.metadata, BACKGROUND_CONTEXT);
		await sleep(600);
		expect(fencedIds).toEqual(["s"]);
		await expect(
			session.mutate((mutator) => mutator.commit([setValue(counter, 1)], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT),
		).rejects.toBeInstanceOf(FencedError);
		expect(a.heldSessionIds).toEqual([]);

		await taken.close(BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		await Promise.all([a.close(BACKGROUND_CONTEXT), b.close(BACKGROUND_CONTEXT)]);
	});

	it("fences a worker process that was paused with SIGSTOP past its TTL", async () => {
		await using schema = await createTestSchema();
		const owner = new PostgresSessionRepo({ sql: schema.sql, lease: leased(B) });
		const seed = new PostgresSessionRepo({ sql: schema.sql });
		await (await seed.create({ id: "s" }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		await seed.close(BACKGROUND_CONTEXT);

		const fixture = fileURLToPath(new URL("./fixtures/fenced-worker.ts", import.meta.url));
		const child = spawn(process.execPath, ["--import", "tsx", fixture, TEST_DATABASE_URL!, schema.schema, "s"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
		try {
			const deadline = Date.now() + 30_000;
			while (!stdout.includes("held") && Date.now() < deadline) await sleep(50);
			expect(stdout, stderr).toContain("held epoch 1");
			while (!/committed \d+/.test(stdout) && Date.now() < deadline) await sleep(50);

			process.kill(child.pid!, "SIGSTOP");
			await sleep(1_500);
			const takeover = await owner.open({ id: "s", createdAt: 0, storageVersion: 1 }, BACKGROUND_CONTEXT);
			expect(takeover.lease).toMatchObject({ epoch: 2, predecessor: "expired" });
			process.kill(child.pid!, "SIGCONT");

			expect(await exited).toBe(3);
			expect(stdout).toContain("fenced");
			await takeover.mutate(
				(mutator) => mutator.commit([setValue(counter, 100)], BACKGROUND_CONTEXT),
				BACKGROUND_CONTEXT,
			);
			expect((await takeover.getValue(counter, BACKGROUND_CONTEXT))?.value).toBe(100);
			await takeover.close(BACKGROUND_CONTEXT);
		} finally {
			if (child.exitCode === null) {
				try {
					process.kill(child.pid!, "SIGCONT");
				} catch {}
				child.kill("SIGKILL");
			}
			await owner.close(BACKGROUND_CONTEXT);
		}
	});
});
