/**
 * Cloud session worker: one process per session.
 *
 * The same shape as the `mini` worker with the two local pieces swapped out. The session lives in
 * PostgreSQL and every tool acts inside an OpenSandbox sandbox whose `/workspace` is a host directory
 * dedicated to the session. The sandbox id is remembered in the session so a replacement worker
 * reconnects to the running sandbox instead of creating a new one.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	type Context,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	value,
} from "@earendil-works/pi-agent-core";
import { findInitialModel } from "@earendil-works/pi-coding-agent/core/model-resolver";
import { ModelRuntime } from "@earendil-works/pi-coding-agent/core/model-runtime";
import { Lane, Models, Worker } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import { createPeer } from "@earendil-works/pi-coding-agent/experimental/mini/shared/rpc";
import { parentConnection } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { LaneService } from "@earendil-works/pi-coding-agent/experimental/mini/worker/lane-service";
import { ModelsService } from "@earendil-works/pi-coding-agent/experimental/mini/worker/models-service";
import { killSandbox, LazySandboxProvider, OpenSandboxExecutionEnv } from "@earendil-works/pi-env-opensandbox";
import { createProxyCredentials, withModelProxy } from "@earendil-works/pi-model-proxy";
import { type PostgresOpenSession, PostgresSessionRepo } from "@earendil-works/pi-session-backend-postgres";
import { type CloudConfig, loadCloudConfig, loadWorkerModelAccess, loadWorkerNodeIdentity } from "../config.ts";
import { CloudWorker } from "../protocol.ts";
import { createSessionClient, sessionLocation, WORKSPACE_CWD } from "../sessions.ts";

/** Which sandbox currently backs this session. Application state, so forks and tree scans ignore it. */
export interface SandboxBinding {
	sandboxId: string;
	boundAt: number;
}

export const sandboxBinding = value<SandboxBinding>("cloud.sandbox", "binding");

function systemPrompt(cwd: string): string {
	return [
		"You are a coding agent working in an isolated Linux sandbox.",
		`Working directory: ${cwd}`,
		"Use the read, write, edit, and bash tools to inspect and change files.",
		"Keep answers short and technical.",
	].join("\n");
}

/** Exit code when another worker took this session over; the supervisor must not restart us on it. */
export const EXIT_FENCED = 75;

async function openSession(
	repo: PostgresSessionRepo,
	sessionId: string,
	create: boolean,
	context: Context,
): Promise<PostgresOpenSession> {
	if (create) return repo.create({ id: sessionId }, context);
	const metadata = (await repo.list(undefined, context)).find((candidate) => candidate.id === sessionId);
	if (!metadata) throw new Error(`Unknown session: ${sessionId}`);
	return repo.open(metadata, context);
}

/**
 * Model access for this worker. Through the proxy, the only credential in this process is a token
 * bound to the session; the proxy holds the vendor keys and every model addresses the proxy route.
 */
async function createModels(
	config: CloudConfig,
): Promise<{ runtime: ModelRuntime; harnessModels: ModelRuntime; viaProxy: boolean }> {
	const access = loadWorkerModelAccess();
	if (access === undefined) {
		const runtime = await ModelRuntime.create();
		return { runtime, harnessModels: runtime, viaProxy: false };
	}
	const credentials = await createProxyCredentials(access.token, access.providers);
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	void config;
	return { runtime, harnessModels: withModelProxy(runtime, access.proxyUrl), viaProxy: true };
}

function sandboxConnection(config: CloudConfig) {
	return {
		domain: config.sandboxDomain,
		...(config.sandboxApiKey === undefined ? {} : { apiKey: config.sandboxApiKey }),
		useServerProxy: true,
		requestTimeoutSeconds: 120,
	};
}

/**
 * Build the execution environment for one session: lazy sandbox, host-backed workspace, remembered id.
 *
 * When this worker took the session over from a holder that expired rather than released, the
 * remembered sandbox may still be running that holder's commands. The lease fences the database;
 * killing the sandbox fences the side effects. The workspace volume survives, so nothing is lost
 * but process state.
 */
export async function createSessionExecutionEnv(
	session: PostgresOpenSession,
	config: CloudConfig,
	context: Context,
): Promise<OpenSandboxExecutionEnv> {
	const sessionId = session.metadata.id;
	const workspaceHostPath = join(config.workspacesRoot, sessionId);
	await mkdir(workspaceHostPath, { recursive: true });
	let remembered = await session.getValue(sandboxBinding, context);
	if (remembered !== undefined && session.lease?.predecessor === "expired") {
		const killed = await killSandbox(sandboxConnection(config), remembered.value.sandboxId);
		console.error(
			`Took over session ${sessionId} from an expired lease; ${killed ? "killed" : "could not reach"} sandbox ${remembered.value.sandboxId}`,
		);
		await session.deleteValue(sandboxBinding, context);
		remembered = undefined;
	}
	const provider = new LazySandboxProvider({
		connectionConfig: sandboxConnection(config),
		create: {
			image: config.sandboxImage,
			timeoutSeconds: config.sandboxTimeoutSeconds,
			readyTimeoutSeconds: 180,
			metadata: { "pi.session": sessionId },
			volumes: [{ name: "workspace", host: { path: workspaceHostPath }, mountPath: WORKSPACE_CWD, readOnly: false }],
		},
		sandboxId: remembered?.value.sandboxId,
		keepAlive: { timeoutSeconds: config.sandboxTimeoutSeconds },
		onProvisioned: async (sandbox, event) => {
			if (event.reason === "connected" && remembered?.value.sandboxId === sandbox.id) return;
			// Not awaited on the mutation line: provisioning happens inside a tool call, and the binding is
			// advisory. A lost write only costs one extra sandbox creation after a restart.
			void session
				.setValue(sandboxBinding, { sandboxId: sandbox.id, boundAt: Date.now() }, context)
				.catch((error: unknown) => console.error("Failed to record sandbox binding:", error));
		},
	});
	return new OpenSandboxExecutionEnv({ provider, cwd: WORKSPACE_CWD, ownsProvider: true });
}

/** Run one cloud session worker until its stdio closes. `create` makes the session under the given id. */
export async function runCloudSessionWorker(options: {
	sessionId: string;
	create: boolean;
	config?: CloudConfig;
}): Promise<void> {
	const config = options.config ?? loadCloudConfig(process.env, "worker");
	const context = BACKGROUND_CONTEXT;
	const sql = createSessionClient(config, "pi-cloud-worker");
	const identity = loadWorkerNodeIdentity();
	const repo = new PostgresSessionRepo({
		sql,
		lease: {
			owner: { node: identity.node, addr: identity.addr, proc: `${process.pid}:${Date.now()}` },
			ttlSeconds: config.leaseTtlSeconds,
			heartbeatIntervalMs: config.leaseHeartbeatMs,
			onFenced: (_sessionId, error) => {
				// Another worker owns the session now. Nothing this process does can be committed; stop at once.
				console.error(`Fenced: ${error.message}`);
				process.exit(EXIT_FENCED);
			},
			onHeartbeatError: (error) => console.error("Lease heartbeat failed:", error),
		},
	});
	const session = await openSession(repo, options.sessionId, options.create, context);
	if (session.lease) {
		console.error(
			`Holding session ${session.metadata.id} lease epoch ${session.lease.epoch} (${session.lease.predecessor})`,
		);
	}
	const executionEnv = await createSessionExecutionEnv(session, config, context);

	const { runtime: modelRuntime, harnessModels, viaProxy } = await createModels(config);
	const { model, thinkingLevel } = await findInitialModel({
		scopedModels: [],
		isContinuing: !options.create,
		...(config.defaultModel === undefined
			? {}
			: { defaultProvider: config.defaultModel.provider, defaultModelId: config.defaultModel.modelId }),
		modelRuntime,
	});
	if (!model) {
		throw new Error(
			viaProxy
				? "No model available through the model proxy. Check PI_MODEL_PROXY_PROVIDERS and PI_DEFAULT_MODEL."
				: "No model available. Configure credentials with `pi` first.",
		);
	}
	console.error(`Models via ${viaProxy ? "proxy" : "local credentials"}; initial ${model.provider}/${model.id}`);

	const { harness, open } = await AgentHarness.create(
		{
			session,
			models: harnessModels,
			model,
			thinkingLevel,
			tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
			toolContext: { env: executionEnv },
			systemPrompt: systemPrompt(WORKSPACE_CWD),
			// Correlates every provider call with the session; the proxy checks it against the token.
			streamOptions: { headers: { "x-pi-session": session.metadata.id } },
		},
		context,
	);
	const lane = await harness.lane("main", context);
	const connection = parentConnection();
	const peer = createPeer(connection);

	const models = new ModelsService(modelRuntime, (event) => peer.emit(Models, event));
	const laneService = new LaneService({
		lane,
		models: modelRuntime,
		context,
		session: { id: session.metadata.id, cwd: WORKSPACE_CWD, path: sessionLocation(config, session.metadata.id) },
		modelsState: () => models.state,
		publish: (subscriptionId, to, event) => peer.emitTo(Lane, { subscriptionId, event }, to),
	});
	peer.provide(Lane, laneService);
	peer.provide(Models, models);
	peer.provide(Worker, { describe: async () => ({ sessionId: session.metadata.id }) });
	peer.provide(CloudWorker, {
		inspect: async () => {
			const execution = await lane.inspectExecution(context);
			return {
				sessionId: session.metadata.id,
				leaseEpoch: session.lease?.epoch,
				busy: execution.current !== null,
				currentOperationId: execution.current?.id ?? null,
			};
		},
	});

	// Creation restores durable operation state without starting effects. Once services are reachable,
	// install a new process-local drive for every operation left open by the previous worker.
	const recoveries = open.map(async (operation) => {
		try {
			const restoredLane = operation.lane === lane.name ? lane : await harness.lane(operation.lane, context);
			const result = await restoredLane.resume(context);
			if (!result.ok) throw result.error;
		} catch (error) {
			console.error(`Failed to resume ${operation.lane}/${operation.operationId}:`, error);
		}
	});

	// Stop on stdio close (the server dropped us) or on a termination signal (the server stopping us).
	// Both take the same path so the lease is released and the next worker can take over at once.
	await new Promise<void>((resolve) => {
		connection.onClose(resolve);
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => resolve());
	});
	laneService.close();
	await harness.close(context).catch(() => {});
	await Promise.all(recoveries);
	await repo.close(context).catch(() => {});
	// Interrupts running commands and closes the provider; the sandbox itself stays for the next worker.
	await executionEnv.cleanup(context).catch(() => {});
	await sql.end().catch(() => {});
	process.exit(0);
}
