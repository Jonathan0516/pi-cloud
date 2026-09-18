/**
 * The `pi-cloud` command: a terminal presentation on a cloud session.
 *
 * Run from the repository root:
 *   tsx --tsconfig tsconfig.json packages/cloud-worker/src/main.ts [--continue | --session <id>] [--socket <path>]
 */

import { connect } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import { runView } from "@earendil-works/pi-coding-agent/experimental/mini/tui/view";
import { loadCloudConfig } from "./config.ts";
import { cloudSocketPath, ensureCloudServer, newestSessionId } from "./host.ts";
import { WORKSPACE_CWD } from "./sessions.ts";

interface CliOptions {
	continueSession?: boolean;
	sessionId?: string;
	socketPath?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
	const options: CliOptions = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--continue" || arg === "-c") options.continueSession = true;
		else if (arg === "--session" || arg === "-s") {
			const id = argv[++index];
			if (!id) throw new Error("--session requires an id");
			options.sessionId = id;
		} else if (arg === "--socket") {
			const path = argv[++index];
			if (!path) throw new Error("--socket requires a path");
			options.socketPath = path;
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

async function main(options: CliOptions): Promise<void> {
	const config = loadCloudConfig();
	const transport = await ensureCloudServer(options.socketPath ?? (await cloudSocketPath()), config);
	let sessionId: string | null = options.sessionId ?? null;
	if (sessionId === null && options.continueSession) sessionId = await newestSessionId(transport);
	const client = await connect(transport, sessionId, WORKSPACE_CWD);
	try {
		await runView(client);
	} finally {
		client.close();
	}
}

main(parseArgs(process.argv.slice(2))).then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
