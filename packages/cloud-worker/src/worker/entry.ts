/** Session worker process entry: `node worker/entry.ts <sessionId> [--create]`. Configuration comes from the environment. */

import { runCloudSessionWorker } from "./run.ts";

const [sessionId, flag] = process.argv.slice(2);
if (!sessionId) throw new Error("Cloud worker requires <sessionId> [--create]");
if (flag !== undefined && flag !== "--create") throw new Error(`Unknown argument: ${flag}`);

void runCloudSessionWorker({ sessionId, create: flag === "--create" }).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
