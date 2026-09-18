import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** How a provider's API expects its key. Derived from the API family, not configured per provider. */
export type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key";

export interface Upstream {
	provider: string;
	/** Vendor base URL; the request path after `/v1/<provider>/` is appended to it. */
	baseUrl: string;
	api: string;
	authStyle: AuthStyle;
}

export function authStyleFor(api: string): AuthStyle {
	if (api.startsWith("anthropic")) return "x-api-key";
	if (api.startsWith("google")) return "x-goog-api-key";
	return "bearer";
}

/**
 * Upstreams from pi-ai's built-in catalog. The proxy, not the worker, decides where a provider's
 * traffic goes, so a compromised worker cannot redirect a vendor key to a host it controls.
 */
export function builtinUpstreams(): Map<string, Upstream> {
	const upstreams = new Map<string, Upstream>();
	for (const provider of builtinProviders()) {
		let models: readonly { baseUrl: string; api: string }[] = [];
		try {
			models = provider.getModels();
		} catch {
			models = [];
		}
		const first = models[0];
		const baseUrl = first?.baseUrl ?? provider.baseUrl;
		if (!baseUrl) continue;
		const api = first?.api ?? "openai-completions";
		upstreams.set(provider.id, { provider: provider.id, baseUrl, api, authStyle: authStyleFor(api) });
	}
	return upstreams;
}

/** Join an upstream base URL with the remainder of a proxied path, keeping the base URL's own path. */
export function upstreamUrl(upstream: Upstream, rest: string, search: string): string {
	const base = upstream.baseUrl.replace(/\/+$/, "");
	const tail = rest.replace(/^\/+/, "");
	return `${base}${tail ? `/${tail}` : ""}${search}`;
}
