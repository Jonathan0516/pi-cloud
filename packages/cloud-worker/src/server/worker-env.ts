import { mintProxyToken } from "@earendil-works/pi-model-proxy";
import { type CloudConfig, cloudConfigToEnv, MODEL_PROXY_SECRET_ENV, workerModelAccessToEnv } from "../config.ts";

/** Variables that look like vendor credentials or endpoint overrides. Workers in proxy mode get none of them. */
const VENDOR_SECRET_PATTERN =
	/(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_ACCESS_TOKEN|_BASE_URL|_SECRET_ACCESS_KEY|_ACCESS_KEY_ID|_SESSION_TOKEN)$/i;
const VENDOR_SECRET_NAMES = new Set(["GOOGLE_APPLICATION_CREDENTIALS", "AWS_PROFILE", MODEL_PROXY_SECRET_ENV]);

export function isVendorSecretVariable(name: string): boolean {
	if (name.startsWith("PI_MODEL_PROXY_") && name !== MODEL_PROXY_SECRET_ENV) return false;
	return VENDOR_SECRET_NAMES.has(name) || VENDOR_SECRET_PATTERN.test(name);
}

/**
 * Environment for one session worker. In proxy mode the worker receives a token bound to its
 * session instead of any vendor key or the minting secret, so the brain never holds a credential
 * that the sandbox side effects could exfiltrate.
 */
export function workerEnvironment(
	base: NodeJS.ProcessEnv,
	config: CloudConfig,
	sessionId: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (config.modelProxy !== undefined && isVendorSecretVariable(name)) continue;
		env[name] = value;
	}
	for (const [name, value] of Object.entries(cloudConfigToEnv(config))) {
		if (name === MODEL_PROXY_SECRET_ENV) continue;
		env[name] = value;
	}
	if (config.modelProxy !== undefined) {
		const token = mintProxyToken(
			config.modelProxy.secret,
			{ tenant: "local", session: sessionId },
			config.modelProxy.tokenTtlSeconds,
		);
		Object.assign(
			env,
			workerModelAccessToEnv({ proxyUrl: config.modelProxy.url, token, providers: config.modelProxy.providers }),
		);
	}
	return { ...env, ...extra };
}
