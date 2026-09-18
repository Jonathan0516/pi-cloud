import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import {
	acquireSessionLease,
	expireSessionLease,
	FencedError,
	fenceSessionLease,
	heartbeatSessionLeases,
	listExpiredSessionLeases,
	PostgresSessionRepo,
	readSessionLease,
	releaseSessionLease,
} from "../src/index.ts";
import { createTestSchema, describePostgres } from "./support.ts";

const A = { node: "node-a", addr: "10.0.0.1:7000", proc: "100:boot" };
const B = { node: "node-b", addr: "10.0.0.2:7000", proc: "200:boot" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describePostgres("session leases", () => {
	it("hands the lease to exactly one acquirer and reports how the predecessor ended", async () => {
		await using schema = await createTestSchema();
		const repo = new PostgresSessionRepo({ sql: schema.sql });
		const session = await repo.create({ id: "s" }, BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);

		const first = await acquireSessionLease(schema.sql, "s", A, 30);
		expect(first).toMatchObject({
			acquired: true,
			predecessor: "none",
			lease: { epoch: 1, owner: A, state: "held" },
		});

		const contended = await acquireSessionLease(schema.sql, "s", B, 30);
		expect(contended).toMatchObject({ acquired: false, holder: { epoch: 1, owner: A } });

		expect(await releaseSessionLease(schema.sql, "s", 99)).toBe(false);
		expect(await releaseSessionLease(schema.sql, "s", 1)).toBe(true);
		expect(await readSessionLease(schema.sql, "s")).toMatchObject({ state: "free", epoch: 1 });

		const handedOver = await acquireSessionLease(schema.sql, "s", B, 30);
		expect(handedOver).toMatchObject({ acquired: true, predecessor: "released", lease: { epoch: 2, owner: B } });
		expect(await releaseSessionLease(schema.sql, "s", 1)).toBe(false);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("lets an expired lease be taken over and fences the stale epoch", async () => {
		await using schema = await createTestSchema();
		const repo = new PostgresSessionRepo({ sql: schema.sql });
		const session = await repo.create({ id: "s" }, BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);

		const short = await acquireSessionLease(schema.sql, "s", A, 1);
		expect(short.acquired).toBe(true);
		expect(await acquireSessionLease(schema.sql, "s", B, 30)).toMatchObject({ acquired: false });
		expect(await listExpiredSessionLeases(schema.sql, 10)).toEqual([]);

		await sleep(1_300);
		expect((await listExpiredSessionLeases(schema.sql, 10)).map((lease) => lease.sessionId)).toEqual(["s"]);
		const takeover = await acquireSessionLease(schema.sql, "s", B, 30);
		expect(takeover).toMatchObject({ acquired: true, predecessor: "expired", lease: { epoch: 2, owner: B } });

		await expect(fenceSessionLease(schema.sql, "s", 1, 30)).rejects.toBeInstanceOf(FencedError);
		await expect(fenceSessionLease(schema.sql, "s", 2, 30)).resolves.toBeUndefined();

		// A supervisor that saw the holder die expires the lease at once; the taker still sees a crash.
		expect(await expireSessionLease(schema.sql, "s", 1)).toBe(false);
		expect(await expireSessionLease(schema.sql, "s", 2)).toBe(true);
		const afterCrash = await acquireSessionLease(schema.sql, "s", A, 30);
		expect(afterCrash).toMatchObject({ acquired: true, predecessor: "expired", lease: { epoch: 3, owner: A } });
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("renews held leases in one batch and reports the ones that were lost", async () => {
		await using schema = await createTestSchema();
		const repo = new PostgresSessionRepo({ sql: schema.sql });
		for (const id of ["one", "two", "three"]) {
			await (await repo.create({ id }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
			expect((await acquireSessionLease(schema.sql, id, A, 30)).acquired).toBe(true);
		}
		expect(await releaseSessionLease(schema.sql, "two", 1)).toBe(true);
		expect((await acquireSessionLease(schema.sql, "three", B, 30)).acquired).toBe(false);
		expect(await releaseSessionLease(schema.sql, "three", 1)).toBe(true);
		expect((await acquireSessionLease(schema.sql, "three", B, 30)).acquired).toBe(true);

		const owned = await heartbeatSessionLeases(
			schema.sql,
			[
				{ sessionId: "one", epoch: 1 },
				{ sessionId: "two", epoch: 1 },
				{ sessionId: "three", epoch: 1 },
			],
			30,
		);
		expect([...owned]).toEqual(["one"]);
		expect(await heartbeatSessionLeases(schema.sql, [], 30)).toEqual(new Set());
		await repo.close(BACKGROUND_CONTEXT);
	});
});
