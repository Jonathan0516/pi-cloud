import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createPostgresClient, PostgresSessionRepo } from "@earendil-works/pi-session-backend-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	clearFault,
	hasOpenOperation,
	listOrphanedOperations,
	readRecoveryRecords,
	recordTakeoverFailure,
	recordTakeoverSuccess,
} from "../src/server/recovery.ts";
import { ensureSessionSchema } from "../src/sessions.ts";

const databaseUrl = process.env.PI_TEST_PG_URL;
const describePg = databaseUrl ? describe : describe.skip;
const schema = `pi_cloud_recovery_${randomUUID().replaceAll("-", "")}`;

describePg("takeover ledger", () => {
	const sql = createPostgresClient({ url: databaseUrl ?? "postgres://unused", schema, max: 2 });

	beforeAll(async () => {
		await ensureSessionSchema(sql, { schema });
	});

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
		await sql.end();
	});

	it("counts failures up to the threshold, then marks the session faulted", async () => {
		expect(await recordTakeoverFailure(sql, "s1", "boom", 3)).toEqual({
			sessionId: "s1",
			failures: 1,
			faulted: false,
		});
		expect(await recordTakeoverFailure(sql, "s1", "boom", 3)).toEqual({
			sessionId: "s1",
			failures: 2,
			faulted: false,
		});
		expect(await recordTakeoverFailure(sql, "s1", "boom", 3)).toEqual({
			sessionId: "s1",
			failures: 3,
			faulted: true,
		});
		expect(await readRecoveryRecords(sql, ["s1", "unknown"])).toEqual(
			new Map([["s1", { sessionId: "s1", failures: 3, faulted: true }]]),
		);
	});

	it("resets the counter on a healthy resume and on an operator clearing the fault", async () => {
		await recordTakeoverFailure(sql, "s2", "boom", 2);
		await recordTakeoverSuccess(sql, "s2");
		expect(await readRecoveryRecords(sql, ["s2"])).toEqual(
			new Map([["s2", { sessionId: "s2", failures: 0, faulted: false }]]),
		);

		await recordTakeoverFailure(sql, "s3", "boom", 1);
		expect((await readRecoveryRecords(sql, ["s3"])).get("s3")?.faulted).toBe(true);
		await clearFault(sql, "s3");
		expect((await readRecoveryRecords(sql, ["s3"])).get("s3")).toEqual({
			sessionId: "s3",
			failures: 0,
			faulted: false,
		});
	});

	it("faults on the first failure when the threshold is one", async () => {
		expect(await recordTakeoverFailure(sql, "s4", "boom", 1)).toMatchObject({ failures: 1, faulted: true });
	});

	it("sees an open operation only while its durable state exists", async () => {
		const repo = new PostgresSessionRepo({ sql });
		const session = await repo.create({ id: "op-session" }, BACKGROUND_CONTEXT);
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
		expect(await hasOpenOperation(sql, "op-session")).toBe(false);
		await sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
			VALUES ('op-session', 'pi.op.state', 'op-1', 1, ${JSON.stringify({ status: "running" })}::text::json)`;
		expect(await hasOpenOperation(sql, "op-session")).toBe(true);
		await sql`DELETE FROM scalar_values WHERE session_id = 'op-session' AND namespace = 'pi.op.state'`;
		expect(await hasOpenOperation(sql, "op-session")).toBe(false);
	});

	it("lists open operations whose lease is missing, released, or expired, never a live one", async () => {
		const repo = new PostgresSessionRepo({ sql });
		for (const id of ["no-lease", "released", "expired", "live", "idle-expired"]) {
			await (await repo.create({ id }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		}
		await repo.close(BACKGROUND_CONTEXT);
		const seed = async (sessionId: string): Promise<void> => {
			await sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
				VALUES (${sessionId}, 'pi.op.state', 'op', 1, '{}'::text::json)`;
		};
		const lease = async (sessionId: string, state: "held" | "free", expiresIn: string): Promise<void> => {
			await sql`INSERT INTO session_leases (session_id, epoch, owner_node, owner_addr, owner_proc, state, heartbeat_at, expires_at)
				VALUES (${sessionId}, 1, 'n', 'a', 'p', ${state}, now(), now() + ${expiresIn}::interval)`;
		};
		await seed("no-lease");
		await seed("released");
		await lease("released", "free", "-1 second");
		await seed("expired");
		await lease("expired", "held", "-1 second");
		await seed("live");
		await lease("live", "held", "1 hour");
		await lease("idle-expired", "held", "-1 second");

		expect(await listOrphanedOperations(sql, 10)).toEqual(["expired", "no-lease", "released"]);
		expect(await listOrphanedOperations(sql, 1)).toEqual(["expired"]);
	});
});
