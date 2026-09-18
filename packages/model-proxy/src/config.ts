import { readFileSync } from "node:fs";
import { authStyleFor, builtinUpstreams, type Upstream } from "./upstreams.ts";

export interface ModelProxyConfig {
	host: string;
	port: number;
	/** HMAC secret shared with the process that mints worker tokens. Never given to workers. */
	secret: string;
	upstreams: Map<string, Upstream>;
	/** Vendor keys by provider. Providers without a key are refused with 502 before any upstream call. */
	keys: Map<string, string>;
	/** `provider/model` patterns with `*` wildcards. Undefined admits every model. */
	allowModels?: string[];
	/** Requests per tenant per minute. */
	rateLimitPerMinute: number;
	billing?: { url: string; schema: string };
	maxRequestBytes: number;
	maxUsageCaptureBytes: number;
}

const ENV_KEY_NAMES: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	"google-vertex": ["GOOGLE_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	groq: ["GROQ_API_KEY"],
	xai: ["XAI_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	zai: ["ZAI_API_KEY"],
	moonshotai: ["MOONSHOT_API_KEY"],
	minimax: ["MINIMAX_API_KEY"],
	cerebras: ["CEREBRAS_API_KEY"],
	fireworks: ["FIREWORKS_API_KEY"],
	together: ["TOGETHER_API_KEY"],
	huggingface: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
};

function envKeyNames(provider: string): string[] {
	return ENV_KEY_NAMES[provider] ?? [`${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`];
}

/** Keys from a pi `auth.json` (`{ provider: { type: "api_key", key } }`); OAuth entries are skipped. */
export function readKeysFile(path: string): Map<string, string> {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, { type?: string; key?: string }>;
	const keys = new Map<string, string>();
	for (const [provider, credential] of Object.entries(parsed)) {
		if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key) {
			keys.set(provider, credential.key);
		}
	}
	return keys;
}

export function resolveVendorKeys(
	providers: Iterable<string>,
	env: NodeJS.ProcessEnv,
	explicit: Map<string, string>,
): Map<string, string> {
	const keys = new Map<string, string>(explicit);
	for (const provider of providers) {
		if (keys.has(provider)) continue;
		for (const name of envKeyNames(provider)) {
			const value = env[name];
			if (value) {
				keys.set(provider, value);
				break;
			}
		}
	}
	return keys;
}

function parseJsonEnv<T>(env: NodeJS.ProcessEnv, name: string): T | undefined {
	const raw = env[name];
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function applyUpstreamOverrides(
	upstreams: Map<string, Upstream>,
	overrides: Record<string, { baseUrl: string; api?: string }> | undefined,
): Map<string, Upstream> {
	if (!overrides) return upstreams;
	const merged = new Map(upstreams);
	for (const [provider, override] of Object.entries(overrides)) {
		const api = override.api ?? merged.get(provider)?.api ?? "openai-completions";
		merged.set(provider, { provider, baseUrl: override.baseUrl, api, authStyle: authStyleFor(api) });
	}
	return merged;
}

export function loadModelProxyConfig(env: NodeJS.ProcessEnv = process.env): ModelProxyConfig {
	const secret = env.PI_MODEL_PROXY_SECRET;
	if (!secret || secret.length < 16) throw new Error("PI_MODEL_PROXY_SECRET must be set to at least 16 characters");
	const upstreams = applyUpstreamOverrides(
		builtinUpstreams(),
		parseJsonEnv<Record<string, { baseUrl: string; api?: string }>>(env, "PI_MODEL_PROXY_UPSTREAMS"),
	);
	const explicit = new Map<string, string>(
		Object.entries(parseJsonEnv<Record<string, string>>(env, "PI_MODEL_PROXY_KEYS") ?? {}),
	);
	if (env.PI_MODEL_PROXY_KEYS_FILE) {
		for (const [provider, key] of readKeysFile(env.PI_MODEL_PROXY_KEYS_FILE)) {
			if (!explicit.has(provider)) explicit.set(provider, key);
		}
	}
	const allow = env.PI_MODEL_PROXY_ALLOW_MODELS?.split(",")
		.map((pattern) => pattern.trim())
		.filter(Boolean);
	return {
		host: env.PI_MODEL_PROXY_HOST || "127.0.0.1",
		port: env.PI_MODEL_PROXY_PORT ? Number.parseInt(env.PI_MODEL_PROXY_PORT, 10) : 9100,
		secret,
		upstreams,
		keys: resolveVendorKeys(upstreams.keys(), env, explicit),
		...(allow && allow.length > 0 ? { allowModels: allow } : {}),
		rateLimitPerMinute: env.PI_MODEL_PROXY_RATE_LIMIT ? Number.parseInt(env.PI_MODEL_PROXY_RATE_LIMIT, 10) : 300,
		...(env.PI_PG_URL ? { billing: { url: env.PI_PG_URL, schema: env.PI_PG_SCHEMA || "pi_cloud" } } : {}),
		maxRequestBytes: 32 * 1024 * 1024,
		maxUsageCaptureBytes: 4 * 1024 * 1024,
	};
}
