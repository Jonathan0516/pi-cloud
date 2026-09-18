/**
 * Test fixture: a worker that holds one session lease with a short TTL, heartbeats, and commits in a
 * loop. It prints `held epoch N` once it owns the session and `committed N` after each commit, and
 * exits with code 3 the moment it is fenced. Usage: `node --import tsx fenced-worker.ts <url> <schema> <sessionId>`.
 */

import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { createPostgresClient, isFencedError, PostgresSessionRepo } from "../../src/index.ts";

const [url, schema, sessionId] = process.argv.slice(2);
if (!url || !schema || !sessionId) throw new Error("usage: fenced-worker <url> <schema> <sessionId>");

const counter = value<number>("test.fence", "counter");
const sql = createPostgresClient({ url, schema, max: 2, applicationName: "fenced-worker" });
const repo = new PostgresSessionRepo({
	sql,
	lease: {
		owner: { node: "child", addr: "child:0", proc: String(process.pid) },
		ttlSeconds: 1,
		heartbeatIntervalMs: 200,
		onFenced: (id, error) => {
			console.log(`fenced ${id}: ${error.message}`);
			process.exit(3);
		},
	},
});

const session = await repo.open({ id: sessionId, createdAt: 0, storageVersion: 1 }, BACKGROUND_CONTEXT);
console.log(`held epoch ${session.lease?.epoch}`);
let count = 0;
while (true) {
	try {
		await session.mutate(
			(mutator) => mutator.commit([setValue(counter, ++count)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		console.log(`committed ${count}`);
	} catch (error) {
		if (isFencedError(error)) {
			console.log(`fenced ${sessionId}: ${error.message}`);
			process.exit(3);
		}
		throw error;
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
}
