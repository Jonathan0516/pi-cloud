/**
 * Worker-side helpers. A worker never sees a vendor key: its credential store holds one proxy
 * token for every admitted provider, and every model's `baseUrl` points at the proxy route for
 * that provider. The provider's own request adapter then sends the token exactly where it would
 * have sent the key, and the proxy swaps it for the real one.
 */

import { type Api, InMemoryCredentialStore, type Model, type Models } from "@earendil-works/pi-ai";

/** Route on the proxy that forwards to `provider`'s upstream. */
export function proxyModelBaseUrl(proxyUrl: string, provider: string): string {
	return `${proxyUrl.replace(/\/+$/, "")}/v1/${encodeURIComponent(provider)}`;
}

/** Credential store whose only secret is the proxy token, offered as the API key of every listed provider. */
export async function createProxyCredentials(
	token: string,
	providers: readonly string[],
): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	for (const provider of providers) {
		await store.modify(provider, async () => ({ type: "api_key", key: token }));
	}
	return store;
}

function rewriteModel<TApi extends Api>(model: Model<TApi>, proxyUrl: string): Model<TApi> {
	return { ...model, baseUrl: proxyModelBaseUrl(proxyUrl, model.provider) };
}

const MODEL_RETURNING = new Set(["getModel"]);
const MODEL_LIST_RETURNING = new Set(["getModels"]);
const MODEL_LIST_PROMISE_RETURNING = new Set(["getAvailable"]);
const MODEL_FIRST_ARGUMENT = new Set([
	"stream",
	"streamSimple",
	"complete",
	"completeSimple",
	"streamDeferred",
	"fetchDeferred",
	"cancelDeferred",
]);

/**
 * Wrap a `Models` so every model it hands out, and every model it is asked to call, addresses the
 * proxy. Other members pass through, so catalog refresh and auth status keep working.
 */
export function withModelProxy<TModels extends Models>(models: TModels, proxyUrl: string): TModels {
	const rewrite = <TApi extends Api>(model: Model<TApi>) => rewriteModel(model, proxyUrl);
	return new Proxy(models, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== "function" || typeof property !== "string") return value;
			const method = value as (...args: unknown[]) => unknown;
			if (MODEL_RETURNING.has(property)) {
				return (...args: unknown[]) => {
					const model = method.apply(target, args) as Model<Api> | undefined;
					return model === undefined ? undefined : rewrite(model);
				};
			}
			if (MODEL_LIST_RETURNING.has(property)) {
				return (...args: unknown[]) => (method.apply(target, args) as readonly Model<Api>[]).map(rewrite);
			}
			if (MODEL_LIST_PROMISE_RETURNING.has(property)) {
				return async (...args: unknown[]) =>
					((await method.apply(target, args)) as readonly Model<Api>[]).map(rewrite);
			}
			if (MODEL_FIRST_ARGUMENT.has(property)) {
				return (model: Model<Api>, ...rest: unknown[]) => method.call(target, rewrite(model), ...rest);
			}
			return method.bind(target);
		},
	});
}
