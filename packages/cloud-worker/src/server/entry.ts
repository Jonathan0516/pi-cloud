/** Server process entry: `node server/entry.ts <socketPath>`. Configuration comes from the environment. */

import { socketTransport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { loadCloudConfig } from "../config.ts";
import { runCloudServer } from "./run.ts";

const [socketPath] = process.argv.slice(2);
if (!socketPath) throw new Error("Cloud server requires <socketPath>");

void runCloudServer({ transport: socketTransport(socketPath), config: loadCloudConfig() }).catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
