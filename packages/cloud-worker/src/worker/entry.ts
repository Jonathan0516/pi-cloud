/** Session worker process entry: `node worker/entry.ts [sessionId]`. Configuration comes from the environment. */

import { runCloudSessionWorker } from "./run.ts";

const [sessionId] = process.argv.slice(2);

void runCloudSessionWorker(sessionId === undefined ? {} : { sessionId }).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
