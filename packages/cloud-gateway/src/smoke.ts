/**
 * Drive one prompt through a running gateway, exactly as a web client would:
 *   tsx --tsconfig tsconfig.json packages/cloud-gateway/src/smoke.ts --url ws://127.0.0.1:7400/v1/ws --key <api-key> [--session <id>] "<prompt>"
 */

import { WORKSPACE_CWD } from "@earendil-works/pi-cloud-worker";
import { type AttachedSession, connect } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import { webSocketTransport } from "./ws.ts";

function waitForRun(
	client: AttachedSession,
	previousOperationId: string | undefined,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for the run to finish")), timeoutMs);
		const check = (): void => {
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
	let url: string | undefined;
	let key: string | undefined;
	let sessionId: string | null = null;
	const words: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--url") url = argv[++index];
		else if (arg === "--key") key = argv[++index];
		else if (arg === "--session") sessionId = argv[++index] ?? null;
		else words.push(arg);
	}
	const prompt = words.join(" ").trim();
	if (!url || !key) throw new Error("--url and --key are required");
	if (!prompt) throw new Error("A prompt is required");

	const client = await connect(webSocketTransport(url, key), sessionId, WORKSPACE_CWD);
	try {
		const state = client.state();
		const previousOperationId = state.lane.lastResult?.operationId;
		console.log(`session ${state.sessionId} (${state.sessionPath}) cwd=${state.cwd}`);
		console.log(`model ${state.lane.configuration.model.provider}/${state.lane.configuration.model.modelId}`);
		const result = await client.lane.prompt(prompt);
		if (!result.ok) throw new Error(`prompt failed: ${result.error}`);
		await waitForRun(client, previousOperationId, 300_000);
		const final = client.state();
		console.log("--- transcript ---");
		for (const entry of final.lane.transcript) {
			const message = entry as { type?: string; role?: string; content?: unknown };
			console.log(
				`${message.role ?? message.type ?? "entry"}: ${JSON.stringify(message.content ?? entry).slice(0, 300)}`,
			);
		}
		console.log(`result: ${final.lane.lastResult?.status}`);
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
