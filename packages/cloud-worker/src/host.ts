/** Presentation-side plumbing shared by the TUI and the scripted smoke client. */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent/config";
import { socketTransport, type Transport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { listSessions } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import type { CloudConfig } from "./config.ts";
import { cloudConfigToEnv } from "./config.ts";
import { loaderArgsFor, loaderEnvFor } from "./process.ts";

const SERVER_ENTRY = fileURLToPath(new URL("./server/entry.ts", import.meta.url));
const SERVER_START_TIMEOUT_MS = 20_000;

export async function cloudSocketPath(): Promise<string> {
	const root = join(getAgentDir(), "experimental");
	await mkdir(root, { recursive: true });
	return join(root, "cloud.sock");
}

/** Connect to the cloud server on `socketPath`, starting a detached one when none answers. */
export async function ensureCloudServer(socketPath: string, config: CloudConfig): Promise<Transport> {
	const transport = socketTransport(socketPath);
	try {
		(await transport.connect()).close();
		return transport;
	} catch {
		// No server yet; start one.
	}
	const child = spawn(process.execPath, [...loaderArgsFor(SERVER_ENTRY), SERVER_ENTRY, socketPath], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, ...cloudConfigToEnv(config), ...loaderEnvFor(SERVER_ENTRY) },
	});
	child.unref();
	const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			(await transport.connect()).close();
			return transport;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	throw new Error("Timed out waiting for the cloud session server");
}

/** Newest session id, or null when none exist. */
export async function newestSessionId(transport: Transport): Promise<string | null> {
	const sessions = await listSessions(transport);
	return sessions.sort((left, right) => left.createdAt - right.createdAt).at(-1)?.id ?? null;
}
