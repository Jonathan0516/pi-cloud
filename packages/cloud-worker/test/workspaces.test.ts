import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createPostgresClient, PostgresSessionRepo } from "@earendil-works/pi-session-backend-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planWorkspaceCleanup, sweepWorkspaces, type WorkspaceCandidate } from "../src/server/workspaces.ts";
import { ensureSessionSchema } from "../src/sessions.ts";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function candidate(overrides: Partial<WorkspaceCandidate> = {}): WorkspaceCandidate {
	return {
		sessionId: "01a0b000-0000-7000-8000-000000000001",
		modifiedAt: NOW - 30 * DAY,
		exists: true,
		leased: false,
		lastActivityAt: NOW - 30 * DAY,
		...overrides,
	};
}

const policy = { now: NOW, retentionMs: 14 * DAY, orphanGraceMs: 60 * 60 * 1000 };

describe("workspace cleanup policy", () => {
	it("never touches a workspace a worker holds, however old", () => {
		const [verdict] = planWorkspaceCleanup([candidate({ leased: true, lastActivityAt: NOW - 400 * DAY })], policy);
		expect(verdict).toMatchObject({ action: "keep" });
		expect(verdict?.reason).toMatch(/worker holds/);
	});

	it("removes a directory whose session is gone, once it is past the grace period", () => {
		const fresh = planWorkspaceCleanup([candidate({ exists: false, modifiedAt: NOW - 60_000 })], policy);
		expect(fresh[0]).toMatchObject({ action: "keep" });
		const old = planWorkspaceCleanup([candidate({ exists: false, modifiedAt: NOW - 2 * 60 * 60 * 1000 })], policy);
		expect(old[0]).toMatchObject({ action: "remove" });
		expect(old[0]?.reason).toMatch(/no longer exists/);
	});

	it("removes a session idle past the retention window and keeps one inside it", () => {
		expect(planWorkspaceCleanup([candidate({ lastActivityAt: NOW - 15 * DAY })], policy)[0]).toMatchObject({
			action: "remove",
		});
		expect(planWorkspaceCleanup([candidate({ lastActivityAt: NOW - 13 * DAY })], policy)[0]).toMatchObject({
			action: "keep",
		});
	});

	it("keeps everything that still exists when retention is disabled", () => {
		const disabled = { ...policy, retentionMs: 0 };
		expect(planWorkspaceCleanup([candidate({ lastActivityAt: NOW - 400 * DAY })], disabled)[0]).toMatchObject({
			action: "keep",
		});
		// An orphan still goes: its session was deleted deliberately.
		expect(planWorkspaceCleanup([candidate({ exists: false })], disabled)[0]).toMatchObject({ action: "remove" });
	});

	it("falls back to the directory mtime when a session has no entries", () => {
		const verdict = planWorkspaceCleanup(
			[candidate({ lastActivityAt: undefined, modifiedAt: NOW - 20 * DAY })],
			policy,
		);
		expect(verdict[0]).toMatchObject({ action: "remove" });
	});
});

const databaseUrl = process.env.PI_TEST_PG_URL;
const describePg = databaseUrl ? describe : describe.skip;
const schema = `pi_cloud_ws_${randomUUID().replaceAll("-", "")}`;

describePg("workspace sweep", () => {
	const sql = createPostgresClient({ url: databaseUrl ?? "postgres://unused", schema, max: 2 });
	const roots: string[] = [];

	beforeAll(async () => {
		await ensureSessionSchema(sql, { schema });
	});

	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
		await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
		await sql.end();
	});

	it("removes orphans and stale sessions, and leaves live ones, the bundle cache, and stray files alone", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ws-"));
		roots.push(root);
		const repo = new PostgresSessionRepo({ sql });
		const live = "01a0b000-0000-7000-8000-00000000live";
		const stale = "01a0b000-0000-7000-8000-000000stale";
		for (const id of [live, stale]) {
			await (await repo.create({ id }, BACKGROUND_CONTEXT)).close(BACKGROUND_CONTEXT);
		}
		await repo.close(BACKGROUND_CONTEXT);
		// The stale session was created "now"; age it by hand so the retention rule can see it.
		await sql`UPDATE sessions SET created_at = ${Date.now() - 30 * DAY} WHERE id = ${stale}`;

		const orphan = "01a0b000-0000-7000-8000-0000000orph";
		for (const name of [live, stale, orphan, ".bundles", "short"]) {
			await mkdir(join(root, name), { recursive: true });
			await writeFile(join(root, name, "file.txt"), "x");
		}
		await writeFile(join(root, "loose-file.txt"), "x");

		const removed = await sweepWorkspaces(sql, {
			workspacesRoot: root,
			retentionMs: 14 * DAY,
			orphanGraceMs: 0,
			log: () => undefined,
		});
		expect(removed.sort()).toEqual([orphan, stale].sort());

		const { readdir } = await import("node:fs/promises");
		expect((await readdir(root)).sort()).toEqual([".bundles", "loose-file.txt", "short", live].sort());
	});

	it("keeps a workspace whose session a live lease holds", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ws-"));
		roots.push(root);
		const held = "01a0b000-0000-7000-8000-00000000held";
		const repo = new PostgresSessionRepo({
			sql,
			lease: { owner: { node: "n", addr: "a:1", proc: "p" }, ttlSeconds: 60, heartbeatIntervalMs: 60_000 },
		});
		const session = await repo.create({ id: held }, BACKGROUND_CONTEXT);
		await mkdir(join(root, held), { recursive: true });
		await sql`UPDATE sessions SET created_at = ${Date.now() - 90 * DAY} WHERE id = ${held}`;
		try {
			const removed = await sweepWorkspaces(sql, {
				workspacesRoot: root,
				retentionMs: DAY,
				orphanGraceMs: 0,
				log: () => undefined,
			});
			expect(removed).toEqual([]);
		} finally {
			await session.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
		}
	});
});
