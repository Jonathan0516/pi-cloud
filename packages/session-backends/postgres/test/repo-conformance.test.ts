import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
	type ConformanceCase,
	createSessionRepoConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { PostgresSessionRepo } from "../src/index.ts";
import { createTestSchema, describePostgres, type TestSchema } from "./support.ts";

const NOW = 1_700_000_000_000;

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describePostgres(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

let current: { schema: TestSchema; repo: PostgresSessionRepo } | undefined;

async function createConformanceRepo(): Promise<PostgresSessionRepo> {
	const schema = await createTestSchema();
	const repo = new PostgresSessionRepo({ sql: schema.sql, now: () => NOW });
	current = { schema, repo };
	return repo;
}

async function cleanupConformanceRepo(): Promise<void> {
	if (current === undefined) return;
	const { schema, repo } = current;
	current = undefined;
	try {
		await repo.close(BACKGROUND_CONTEXT);
	} finally {
		await schema[Symbol.asyncDispose]();
	}
}

registerConformance(
	"PostgresSessionRepo conformance",
	createSessionRepoConformance(createConformanceRepo, cleanupConformanceRepo),
);

async function createLeasedConformanceRepo(): Promise<PostgresSessionRepo> {
	const schema = await createTestSchema();
	const repo = new PostgresSessionRepo({
		sql: schema.sql,
		now: () => NOW,
		lease: {
			owner: { node: "test", addr: "test:0", proc: String(process.pid) },
			ttlSeconds: 30,
			heartbeatIntervalMs: 0,
		},
	});
	current = { schema, repo };
	return repo;
}

registerConformance(
	"PostgresSessionRepo conformance (leased)",
	createSessionRepoConformance(createLeasedConformanceRepo, cleanupConformanceRepo),
);
