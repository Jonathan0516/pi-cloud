import { hostname } from "node:os";

/** Deployment settings for the cloud worker slice, read from the environment. */
export interface CloudConfig {
	/** PostgreSQL connection URL holding the session tables. */
	databaseUrl: string;
	/** Schema for the session tables. */
	schema: string;
	/** OpenSandbox lifecycle server `host[:port]`. */
	sandboxDomain: string;
	sandboxApiKey?: string;
	/** Image every session sandbox starts from. */
	sandboxImage: string;
	/** Sandbox TTL; renewed while a worker uses it. */
	sandboxTimeoutSeconds: number;
	/** Host directory whose per-session subdirectories are mounted at `/workspace`. */
	workspacesRoot: string;
	/** Session lease TTL; a worker silent for longer loses its session. */
	leaseTtlSeconds: number;
	/** Batched lease heartbeat interval. */
	leaseHeartbeatMs: number;
	/** Model proxy the workers call instead of vendors. Absent: workers use local credentials directly. */
	modelProxy?: {
		url: string;
		/** Token-minting secret. Held by the server only; workers receive tokens. */
		secret: string;
		/** Providers workers may address through the proxy. */
		providers: string[];
		tokenTtlSeconds: number;
	};
	/** Initial model for new sessions, as `provider/modelId`. Absent: the local pi default. */
	defaultModel?: { provider: string; modelId: string };
	/** Stable identity of this node; leases record it as `owner_node`. */
	nodeId: string;
	/** TCP bind for inter-node routing and remote presentations. Port 0 picks a free port. */
	nodeListenHost: string;
	nodeListenPort: number;
	/** `host:port` other nodes dial; leases record it as `owner_addr`. Defaults to the bound address. */
	nodeAdvertiseAddr?: string;
	/** Keep running with no presentations and no workers (a node), instead of retiring like the CLI server. */
	nodePersistent: boolean;
	/** Reaper cadence and per-tick takeover budget. */
	reaperIntervalMs: number;
	reaperTakeoversPerTick: number;
	/** Failed resumes after which a session is left alone. */
	poisonThreshold: number;
	/** How long a worker with no viewers and no operation stays warm before it is stopped. */
	workerIdleGraceMs: number;
}

/** What a worker needs to reach models through the proxy. Never includes the minting secret. */
export interface WorkerModelAccess {
	proxyUrl: string;
	token: string;
	providers: string[];
}

const ENV = {
	databaseUrl: "PI_PG_URL",
	schema: "PI_PG_SCHEMA",
	sandboxDomain: "OPEN_SANDBOX_DOMAIN",
	sandboxApiKey: "OPEN_SANDBOX_API_KEY",
	sandboxImage: "PI_SANDBOX_IMAGE",
	sandboxTimeoutSeconds: "PI_SANDBOX_TIMEOUT_SECONDS",
	workspacesRoot: "PI_WORKSPACES_ROOT",
	leaseTtlSeconds: "PI_LEASE_TTL_SECONDS",
	leaseHeartbeatMs: "PI_LEASE_HEARTBEAT_MS",
	modelProxyUrl: "PI_MODEL_PROXY_URL",
	modelProxySecret: "PI_MODEL_PROXY_SECRET",
	modelProxyProviders: "PI_MODEL_PROXY_PROVIDERS",
	modelProxyTokenTtlSeconds: "PI_MODEL_PROXY_TOKEN_TTL_SECONDS",
	modelProxyToken: "PI_MODEL_PROXY_TOKEN",
	defaultModel: "PI_DEFAULT_MODEL",
	nodeId: "PI_NODE_ID",
	nodeListenHost: "PI_NODE_LISTEN_HOST",
	nodeListenPort: "PI_NODE_LISTEN_PORT",
	nodeAdvertiseAddr: "PI_NODE_ADVERTISE_ADDR",
	nodePersistent: "PI_NODE_PERSISTENT",
	reaperIntervalMs: "PI_REAPER_INTERVAL_MS",
	reaperTakeoversPerTick: "PI_REAPER_TAKEOVERS_PER_TICK",
	poisonThreshold: "PI_POISON_THRESHOLD",
	workerIdleGraceMs: "PI_WORKER_IDLE_GRACE_MS",
	/** Worker-only: the node that spawned it, for lease ownership. */
	nodeAddr: "PI_NODE_ADDR",
} as const;

export const DEFAULT_REAPER_INTERVAL_MS = 5000;
export const DEFAULT_REAPER_TAKEOVERS_PER_TICK = 2;
export const DEFAULT_POISON_THRESHOLD = 3;
export const DEFAULT_WORKER_IDLE_GRACE_MS = 30_000;

export const DEFAULT_MODEL_PROXY_PROVIDERS = ["anthropic", "openai", "deepseek"];
export const DEFAULT_MODEL_PROXY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const DEFAULT_SANDBOX_IMAGE = "opensandbox/code-interpreter:v1.1.0";
export const DEFAULT_SCHEMA = "pi_cloud";
export const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 1800;
export const DEFAULT_LEASE_TTL_SECONDS = 30;
export const DEFAULT_LEASE_HEARTBEAT_MS = 5000;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum = 1): number {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
	return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set`);
	return value;
}

export type CloudRole = "server" | "worker";

/**
 * Read the configuration from `env`. Missing required values throw with the variable name. The
 * server must hold the proxy minting secret; a worker deliberately never receives it.
 */
export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env, role: CloudRole = "server"): CloudConfig {
	return {
		databaseUrl: required(env, ENV.databaseUrl),
		schema: env[ENV.schema] || DEFAULT_SCHEMA,
		sandboxDomain: required(env, ENV.sandboxDomain),
		...(env[ENV.sandboxApiKey] ? { sandboxApiKey: env[ENV.sandboxApiKey] } : {}),
		sandboxImage: env[ENV.sandboxImage] || DEFAULT_SANDBOX_IMAGE,
		sandboxTimeoutSeconds: integer(env, ENV.sandboxTimeoutSeconds, DEFAULT_SANDBOX_TIMEOUT_SECONDS),
		workspacesRoot: required(env, ENV.workspacesRoot),
		leaseTtlSeconds: integer(env, ENV.leaseTtlSeconds, DEFAULT_LEASE_TTL_SECONDS),
		leaseHeartbeatMs: integer(env, ENV.leaseHeartbeatMs, DEFAULT_LEASE_HEARTBEAT_MS),
		...modelProxyFromEnv(env, role),
		...defaultModelFromEnv(env),
		nodeId: env[ENV.nodeId] || `${hostname()}:${process.pid}`,
		nodeListenHost: env[ENV.nodeListenHost] || "127.0.0.1",
		nodeListenPort: integer(env, ENV.nodeListenPort, 0, 0),
		...(env[ENV.nodeAdvertiseAddr] ? { nodeAdvertiseAddr: env[ENV.nodeAdvertiseAddr] } : {}),
		nodePersistent: env[ENV.nodePersistent] === "1" || env[ENV.nodePersistent] === "true",
		reaperIntervalMs: integer(env, ENV.reaperIntervalMs, DEFAULT_REAPER_INTERVAL_MS, 0),
		reaperTakeoversPerTick: integer(env, ENV.reaperTakeoversPerTick, DEFAULT_REAPER_TAKEOVERS_PER_TICK, 0),
		poisonThreshold: integer(env, ENV.poisonThreshold, DEFAULT_POISON_THRESHOLD),
		workerIdleGraceMs: integer(env, ENV.workerIdleGraceMs, DEFAULT_WORKER_IDLE_GRACE_MS, 0),
	};
}

/** Lease owner identity for a worker: the node that spawned it, or this process when run alone. */
export function loadWorkerNodeIdentity(env: NodeJS.ProcessEnv = process.env): { node: string; addr: string } {
	const node = env[ENV.nodeId] || `${hostname()}:${process.pid}`;
	return { node, addr: env[ENV.nodeAddr] || node };
}

/** Variables telling a worker which node owns it. */
export function workerNodeIdentityToEnv(identity: { node: string; addr: string }): Record<string, string> {
	return { [ENV.nodeId]: identity.node, [ENV.nodeAddr]: identity.addr };
}

function modelProxyFromEnv(env: NodeJS.ProcessEnv, role: CloudRole): Pick<CloudConfig, "modelProxy"> {
	const url = env[ENV.modelProxyUrl];
	if (!url) return {};
	const secret = env[ENV.modelProxySecret];
	if (!secret || secret.length < 16) {
		if (role === "worker") return {};
		throw new Error(`${ENV.modelProxySecret} must be set to at least 16 characters when ${ENV.modelProxyUrl} is set`);
	}
	return {
		modelProxy: {
			url,
			secret,
			providers: parseProviders(env[ENV.modelProxyProviders]),
			tokenTtlSeconds: integer(env, ENV.modelProxyTokenTtlSeconds, DEFAULT_MODEL_PROXY_TOKEN_TTL_SECONDS),
		},
	};
}

function parseProviders(raw: string | undefined): string[] {
	const providers = (raw ?? "")
		.split(",")
		.map((provider) => provider.trim())
		.filter(Boolean);
	return providers.length > 0 ? providers : [...DEFAULT_MODEL_PROXY_PROVIDERS];
}

function defaultModelFromEnv(env: NodeJS.ProcessEnv): Pick<CloudConfig, "defaultModel"> {
	const raw = env[ENV.defaultModel];
	if (!raw) return {};
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) throw new Error(`${ENV.defaultModel} must be provider/modelId`);
	return { defaultModel: { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) } };
}

/** Worker-side view: proxy URL, its own token, and the providers the token admits. */
export function loadWorkerModelAccess(env: NodeJS.ProcessEnv = process.env): WorkerModelAccess | undefined {
	const proxyUrl = env[ENV.modelProxyUrl];
	const token = env[ENV.modelProxyToken];
	if (!proxyUrl || !token) return undefined;
	return { proxyUrl, token, providers: parseProviders(env[ENV.modelProxyProviders]) };
}

/** Environment variables a worker needs for `access`. */
export function workerModelAccessToEnv(access: WorkerModelAccess): Record<string, string> {
	return {
		[ENV.modelProxyUrl]: access.proxyUrl,
		[ENV.modelProxyToken]: access.token,
		[ENV.modelProxyProviders]: access.providers.join(","),
	};
}

/** Variables that must never reach a worker in proxy mode. */
export const MODEL_PROXY_SECRET_ENV = ENV.modelProxySecret;

/** Environment variables that reproduce `config` in a child process. */
export function cloudConfigToEnv(config: CloudConfig): Record<string, string> {
	return {
		[ENV.databaseUrl]: config.databaseUrl,
		[ENV.schema]: config.schema,
		[ENV.sandboxDomain]: config.sandboxDomain,
		...(config.sandboxApiKey === undefined ? {} : { [ENV.sandboxApiKey]: config.sandboxApiKey }),
		[ENV.sandboxImage]: config.sandboxImage,
		[ENV.sandboxTimeoutSeconds]: String(config.sandboxTimeoutSeconds),
		[ENV.workspacesRoot]: config.workspacesRoot,
		[ENV.leaseTtlSeconds]: String(config.leaseTtlSeconds),
		[ENV.leaseHeartbeatMs]: String(config.leaseHeartbeatMs),
		...(config.modelProxy === undefined
			? {}
			: {
					[ENV.modelProxyUrl]: config.modelProxy.url,
					[ENV.modelProxySecret]: config.modelProxy.secret,
					[ENV.modelProxyProviders]: config.modelProxy.providers.join(","),
					[ENV.modelProxyTokenTtlSeconds]: String(config.modelProxy.tokenTtlSeconds),
				}),
		...(config.defaultModel === undefined
			? {}
			: { [ENV.defaultModel]: `${config.defaultModel.provider}/${config.defaultModel.modelId}` }),
		[ENV.nodeId]: config.nodeId,
		[ENV.nodeListenHost]: config.nodeListenHost,
		[ENV.nodeListenPort]: String(config.nodeListenPort),
		...(config.nodeAdvertiseAddr === undefined ? {} : { [ENV.nodeAdvertiseAddr]: config.nodeAdvertiseAddr }),
		[ENV.nodePersistent]: config.nodePersistent ? "1" : "0",
		[ENV.reaperIntervalMs]: String(config.reaperIntervalMs),
		[ENV.reaperTakeoversPerTick]: String(config.reaperTakeoversPerTick),
		[ENV.poisonThreshold]: String(config.poisonThreshold),
		[ENV.workerIdleGraceMs]: String(config.workerIdleGraceMs),
	};
}
