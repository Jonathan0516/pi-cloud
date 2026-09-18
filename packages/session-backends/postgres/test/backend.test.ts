import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { expect, it } from "vitest";
import { PostgresSessionRepo } from "../src/index.ts";
import { createTestSchema, describePostgres } from "./support.ts";

const NOW = 1_700_000_000_000;
const NUL = String.fromCharCode(0);

describePostgres("PostgreSQL backend specifics", () => {
	it("parses bigint columns as numbers and round-trips JSON exactly", async () => {
		await using schema = await createTestSchema();
		const repo = new PostgresSessionRepo({ sql: schema.sql, now: () => NOW });
		const session = await repo.create({ id: "json" }, BACKGROUND_CONTEXT);
		const address = value<unknown>("test.json");
		const stored = {
			nul: `before${NUL}after`,
			unicode: "日本語 🦞",
			order: { z: 1, a: 2 },
			caseKeys: { key: 1, KEY: 2 },
			nested: [null, true, 1.5, -0.25, 1e21, "x"],
		};

		const result = await session.mutate(
			(mutator) => mutator.commit([setValue(address, stored)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		const read = await session.getValue(address, BACKGROUND_CONTEXT);

		expect(typeof result.firstSeq).toBe("number");
		expect(typeof session.metadata.createdAt).toBe("number");
		expect(read?.seq).toBe(result.firstSeq);
		expect(read?.value).toStrictEqual(stored);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("orders and bounds key prefix scans by code point regardless of database collation", async () => {
		await using schema = await createTestSchema();
		const repo = new PostgresSessionRepo({ sql: schema.sql, now: () => NOW });
		const session = await repo.create({ id: "collation" }, BACKGROUND_CONTEXT);
		const keys = ["b", "B", "a", "ab", "a~", "a-", "A", "bb"];
		await session.mutate(
			(mutator) =>
				mutator.commit(
					keys.map((key) => setValue(value<string>("test.collation", key), key)),
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		const scanned = await session.scanValues(value<string>("test.collation", "a"), BACKGROUND_CONTEXT);

		expect(scanned.map((stored) => stored.address.key)).toStrictEqual(["a", "a-", "ab", "a~"]);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});

	it("keeps sessions independent within one schema and cascades deletes", async () => {
		await using schema = await createTestSchema();
		const repo = new PostgresSessionRepo({ sql: schema.sql, now: () => NOW });
		const kept = await repo.create({ id: "kept" }, BACKGROUND_CONTEXT);
		const removed = await repo.create({ id: "removed" }, BACKGROUND_CONTEXT);
		const main = await removed.createBranch("main", null, BACKGROUND_CONTEXT);
		await main.appendMessage({ role: "user", content: "hello", timestamp: NOW }, BACKGROUND_CONTEXT);
		await kept.setName("kept", BACKGROUND_CONTEXT);
		await Promise.all([kept.close(BACKGROUND_CONTEXT), removed.close(BACKGROUND_CONTEXT)]);

		await repo.delete(removed.metadata, BACKGROUND_CONTEXT);

		const [entries] = await schema.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM entries`;
		expect(entries?.count).toBe(0);
		const [branches] = await schema.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM branch_meta`;
		expect(branches?.count).toBe(0);
		const reopened = await repo.open(kept.metadata, BACKGROUND_CONTEXT);
		expect(await reopened.getName(BACKGROUND_CONTEXT)).toBe("kept");
		await reopened.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});
});
