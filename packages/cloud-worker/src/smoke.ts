/**
 * Scripted client: attach to a session, send one prompt, print the transcript once the lane is idle.
 *
 *   tsx --tsconfig tsconfig.json packages/cloud-worker/src/smoke.ts [--session <id>] [--kill-after <ms>] [--socket <path>] "<prompt>"
 *
 * `--kill-after` sends SIGKILL to the session worker mid-run and reattaches, to exercise recovery.
 */

import { execFileSync } from "node:child_process";
import type { Entry } from "@earendil-works/pi-agent-core";
import { type AttachedSession, connect } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import { loadCloudConfig } from "./config.ts";
import { cloudSocketPath, ensureCloudServer } from "./host.ts";
import { WORKSPACE_CWD } from "./sessions.ts";

function describeEntry(entry: Entry): string {
	if (entry.type !== "message") return `[${entry.type}]`;
	const message = entry.message;
	if (!("content" in message)) return `[${message.role}]`;
	const content: unknown = message.content;
	if (typeof content === "string") return `${message.role}: ${content}`;
	if (!Array.isArray(content)) return `${message.role}: ${JSON.stringify(content)}`;
	const parts = content.map((part: unknown) => {
		const record = part as { type?: string; text?: string; name?: string; arguments?: unknown };
		switch (record.type) {
			case "text":
				return record.text ?? "";
			case "toolCall":
				return `<tool ${record.name} ${JSON.stringify(record.arguments)}>`;
			default:
				return `<${record.type ?? "part"} ${JSON.stringify(part).slice(0, 300)}>`;
		}
	});
	return `${message.role}: ${parts.join("")}`;
}

async function reconnectUntilLeaseFree(
	transport: Awaited<ReturnType<typeof ensureCloudServer>>,
	sessionId: string,
	timeoutMs: number,
): Promise<AttachedSession> {
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	while (true) {
		try {
			return await connect(transport, sessionId, WORKSPACE_CWD);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (Date.now() > deadline) throw error;
			if (attempt++ === 0) console.log(`attach failed (${message.split("\n")[0]}); retrying until the lease frees`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}

/** Resolve once a run other than `previousOperationId` has finished and the lane is idle again. */
function waitForRun(
	client: AttachedSession,
	previousOperationId: string | undefined,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for the run to finish")), timeoutMs);
		const check = () => {
			const lane = client.state().lane;
			if (
				lane.operation === null &&
				lane.lastResult !== undefined &&
				lane.lastResult.operationId !== previousOperationId
			) {
				clearTimeout(timer);
				unsubscribe();
				resolve();
			}
		};
		const unsubscribe = client.subscribe(check);
		check();
	});
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let sessionId: string | null = null;
	let killAfterMs: number | undefined;
	let socketPath: string | undefined;
	const words: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--session") sessionId = argv[++index] ?? null;
		else if (arg === "--kill-after") killAfterMs = Number.parseInt(argv[++index] ?? "", 10);
		else if (arg === "--socket") socketPath = argv[++index];
		else words.push(arg);
	}
	const prompt = words.join(" ");
	if (!prompt) throw new Error("A prompt is required");

	const config = loadCloudConfig();
	const transport = await ensureCloudServer(socketPath ?? (await cloudSocketPath()), config);
	let client = await connect(transport, sessionId, WORKSPACE_CWD);
	try {
		const state = client.state();
		const previousOperationId = state.lane.lastResult?.operationId;
		console.log(`session ${state.sessionId} (${state.sessionPath}) cwd=${state.cwd}`);
		console.log(`model ${state.lane.configuration.model.provider}/${state.lane.configuration.model.modelId}`);
		// `prompt` settles when the run ends, so the kill timer must start before awaiting it.
		const submitted = client.lane.prompt(prompt);
		submitted.then(
			(result) => {
				if (!result.ok) console.error(`prompt failed: ${result.error}`);
			},
			() => undefined,
		);

		if (killAfterMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, killAfterMs));
			const pids = execFileSync("pgrep", ["-f", `worker/entry.ts ${state.sessionId}`], { encoding: "utf8" })
				.split("\n")
				.filter(Boolean);
			console.log(`killing worker pid(s) ${pids.join(", ")} mid-run`);
			for (const pid of pids) process.kill(Number(pid), "SIGKILL");
			client.close();
			// The dead worker's lease is released only by expiry, so reattaching can take up to the TTL.
			client = await reconnectUntilLeaseFree(transport, state.sessionId, 120_000);
			console.log("reattached; waiting for recovery");
		}

		await waitForRun(client, previousOperationId, 300_000);
		const final = client.state();
		console.log("--- transcript ---");
		for (const entry of final.lane.transcript) console.log(describeEntry(entry));
		console.log("--- stats ---");
		console.log(JSON.stringify(final.lane.stats));
		if (final.lane.lastResult) console.log(`result: ${final.lane.lastResult.status}`);
	} finally {
		client.close();
	}
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
