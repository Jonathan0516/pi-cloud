import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
	type ConformanceCase,
	createStorageConformance,
	type StorageFixture,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { describe, it } from "vitest";
import { POSTGRES_STORAGE_VERSION, PostgresStorage } from "../src/index.ts";
import { createTestSchema, describePostgres } from "./support.ts";

const SESSION_ID = "session";
const NOW = 1_700_000_000_000;
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

registerConformance(
	"PostgresStorage conformance",
	createStorageConformance(async () => {
		const schema = await createTestSchema();
		try {
			await schema.sql`INSERT INTO sessions
				(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
				VALUES (${SESSION_ID}, ${NOW}, ${null}, ${POSTGRES_STORAGE_VERSION}, ${null}, ${0}, ${JSON.stringify(EMPTY_USAGE)}::text::json, ${1})`;
			const storage = new PostgresStorage(schema.sql, { sessionId: SESSION_ID, now: () => NOW });
			return {
				storage,
				async [Symbol.asyncDispose]() {
					try {
						await storage.close(BACKGROUND_CONTEXT);
					} finally {
						await schema[Symbol.asyncDispose]();
					}
				},
			} satisfies StorageFixture;
		} catch (error) {
			await schema[Symbol.asyncDispose]();
			throw error;
		}
	}),
);
