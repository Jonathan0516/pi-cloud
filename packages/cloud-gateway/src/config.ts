/** Gateway configuration from the environment. */

export interface GatewayConfig {
	host: string;
	port: number;
	/** PostgreSQL holding the session tables, the tenant catalog, and the API keys. */
	databaseUrl: string;
	schema: string;
	/** `host:port` of nodes to hand sessions nobody holds. Tried in order; the first reachable wins. */
	nodes: string[];
	/** Dialing a node longer than this counts as unreachable. */
	nodeConnectTimeoutMs: number;
	/** Keys installed at start so a fresh deployment has a way in. Stored hashed; the row keeps the label. */
	bootstrapKeys: Array<{ key: string; tenant: string; user: string }>;
	/** Optional: public URL clients are told to use (behind a load balancer). */
	publicUrl?: string;
	/** Directory of the built web client to serve at `/`. Absent: no static files. */
	webDir?: string;
}

const ENV = {
	host: "PI_GATEWAY_HOST",
	port: "PI_GATEWAY_PORT",
	databaseUrl: "PI_PG_URL",
	schema: "PI_PG_SCHEMA",
	nodes: "PI_GATEWAY_NODES",
	nodeConnectTimeoutMs: "PI_GATEWAY_NODE_TIMEOUT_MS",
	bootstrapKeys: "PI_GATEWAY_BOOTSTRAP_KEYS",
	publicUrl: "PI_GATEWAY_PUBLIC_URL",
	webDir: "PI_GATEWAY_WEB_DIR",
} as const;

const DEFAULT_SCHEMA = "pi_cloud";
const DEFAULT_PORT = 7400;
const DEFAULT_NODE_TIMEOUT_MS = 5_000;
/** API keys are random; anything shorter than this is not one of ours. */
export const MIN_API_KEY_LENGTH = 24;

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} must be set`);
	return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum = 1): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
	return parsed;
}

/** `tenant:user:key[,tenant:user:key...]`; the key itself may not contain `:` or `,`. */
export function parseBootstrapKeys(raw: string | undefined): GatewayConfig["bootstrapKeys"] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const parts = entry.split(":");
			if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
				throw new Error(`${ENV.bootstrapKeys} entries must be tenant:user:key`);
			}
			const [tenant, user, key] = parts as [string, string, string];
			if (key.length < MIN_API_KEY_LENGTH) {
				throw new Error(`${ENV.bootstrapKeys}: keys must be at least ${MIN_API_KEY_LENGTH} characters`);
			}
			return { tenant, user, key };
		});
}

export function parseNodes(raw: string | undefined): string[] {
	const nodes = (raw ?? "")
		.split(",")
		.map((node) => node.trim())
		.filter((node) => node.length > 0);
	for (const node of nodes) {
		if (!/^[^\s:]+:\d+$/.test(node)) throw new Error(`${ENV.nodes} entries must be host:port, got ${node}`);
	}
	return nodes;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
	const nodes = parseNodes(env[ENV.nodes]);
	if (nodes.length === 0) throw new Error(`${ENV.nodes} must list at least one node as host:port`);
	return {
		host: env[ENV.host] || "127.0.0.1",
		port: integer(env, ENV.port, DEFAULT_PORT, 0),
		databaseUrl: required(env, ENV.databaseUrl),
		schema: env[ENV.schema] || DEFAULT_SCHEMA,
		nodes,
		nodeConnectTimeoutMs: integer(env, ENV.nodeConnectTimeoutMs, DEFAULT_NODE_TIMEOUT_MS),
		bootstrapKeys: parseBootstrapKeys(env[ENV.bootstrapKeys]),
		...(env[ENV.publicUrl] ? { publicUrl: env[ENV.publicUrl] } : {}),
		...(env[ENV.webDir] ? { webDir: env[ENV.webDir] } : {}),
	};
}
