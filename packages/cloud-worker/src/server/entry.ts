/**
 * Node process entry: `node server/entry.ts [socketPath]`. Configuration comes from the environment.
 * The unix socket serves local presentations (the CLI); the TCP listener serves other nodes.
 */

import { socketTransport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { loadCloudConfig } from "../config.ts";
import { runCloudServer } from "./run.ts";

const [socketPath] = process.argv.slice(2);

void runCloudServer({
	config: loadCloudConfig(),
	...(socketPath ? { transport: socketTransport(socketPath) } : {}),
}).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
