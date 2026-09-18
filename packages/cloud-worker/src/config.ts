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
} as const;

export const DEFAULT_SANDBOX_IMAGE = "opensandbox/code-interpreter:v1.1.0";
export const DEFAULT_SCHEMA = "pi_cloud";
export const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 1800;
export const DEFAULT_LEASE_TTL_SECONDS = 30;
export const DEFAULT_LEASE_HEARTBEAT_MS = 5000;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set`);
	return value;
}

/** Read the configuration from `env`. Missing required values throw with the variable name. */
export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
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
	};
}

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
	};
}
