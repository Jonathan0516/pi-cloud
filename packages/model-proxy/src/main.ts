/**
 * Run the model proxy from the environment:
 *   PI_MODEL_PROXY_SECRET (required), PI_MODEL_PROXY_PORT (9100), PI_MODEL_PROXY_KEYS_FILE (a pi auth.json),
 *   vendor keys as <PROVIDER>_API_KEY, PI_PG_URL + PI_PG_SCHEMA for billing_events.
 */

import { loadModelProxyConfig } from "./config.ts";
import { startModelProxy } from "./server.ts";

const config = loadModelProxyConfig();
const proxy = await startModelProxy(config);
const providers = [...config.upstreams.keys()].filter((id) => config.keys.has(id));
console.error(`model proxy listening on ${proxy.url}; providers with keys: ${providers.join(", ") || "(none)"}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		void proxy.close().then(() => process.exit(0));
	});
}
