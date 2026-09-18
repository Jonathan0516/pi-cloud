import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createPostgresClient, type PostgresClient } from "@earendil-works/pi-session-backend-postgres";
import { type BillingEvent, ensureBillingSchema, recordBillingEvent } from "./billing.ts";
import type { ModelProxyConfig } from "./config.ts";
import { type ProxyTokenClaims, verifyProxyToken } from "./token.ts";
import { type Upstream, upstreamUrl } from "./upstreams.ts";
import { extractUsage } from "./usage.ts";

/** Headers that never cross the proxy in either direction. */
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
	"content-encoding",
	"accept-encoding",
]);
/** Headers that may carry the worker's token; all are stripped before forwarding. */
const TOKEN_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];
const CORRELATION_HEADERS = ["x-pi-session", "x-pi-operation"];

export interface RunningModelProxy {
	server: Server;
	port: number;
	url: string;
	close(): Promise<void>;
}

export interface ModelProxyHooks {
	/** Observe every proxied call; defaults to billing when configured, otherwise stderr. */
	onEvent?: (event: BillingEvent) => void;
}

class ProxyError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Token bucket per tenant. Refills continuously; capacity equals the per-minute limit. */
class RateLimiter {
	readonly #buckets = new Map<string, { tokens: number; at: number }>();
	readonly #perMinute: number;

	constructor(perMinute: number) {
		this.#perMinute = perMinute;
	}

	take(tenant: string, now = Date.now()): boolean {
		if (this.#perMinute <= 0) return true;
		const bucket = this.#buckets.get(tenant) ?? { tokens: this.#perMinute, at: now };
		bucket.tokens = Math.min(this.#perMinute, bucket.tokens + ((now - bucket.at) / 60_000) * this.#perMinute);
		bucket.at = now;
		if (bucket.tokens < 1) {
			this.#buckets.set(tenant, bucket);
			return false;
		}
		bucket.tokens -= 1;
		this.#buckets.set(tenant, bucket);
		return true;
	}
}

function globToRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	);
}

function modelAllowed(allow: string[] | undefined, provider: string, model: string | undefined): boolean {
	if (allow === undefined) return true;
	const candidate = `${provider}/${model ?? ""}`;
	return allow.some((pattern) => globToRegExp(pattern).test(candidate));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

/** The worker's token, wherever the provider adapter put it. */
function presentedToken(req: IncomingMessage, url: URL): string | undefined {
	const authorization = headerValue(req, "authorization");
	if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
	for (const name of ["x-api-key", "x-goog-api-key"]) {
		const value = headerValue(req, name);
		if (value) return value;
	}
	return url.searchParams.get("key") ?? undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new ProxyError(413, `Request body exceeds ${limit} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function requestedModel(body: Buffer, contentType: string | undefined): string | undefined {
	if (!contentType?.includes("application/json") || body.length === 0) return undefined;
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { model?: unknown };
		return typeof parsed.model === "string" ? parsed.model : undefined;
	} catch {
		return undefined;
	}
}

function forwardHeaders(req: IncomingMessage, upstream: Upstream, key: string): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower) || TOKEN_HEADERS.includes(lower) || CORRELATION_HEADERS.includes(lower)) continue;
		if (lower.startsWith("x-pi-")) continue;
		headers.set(name, Array.isArray(value) ? value.join(", ") : value);
	}
	switch (upstream.authStyle) {
		case "x-api-key":
			headers.set("x-api-key", key);
			break;
		case "x-goog-api-key":
			headers.set("x-goog-api-key", key);
			break;
		default:
			headers.set("authorization", `Bearer ${key}`);
	}
	return headers;
}

function writeJsonError(res: ServerResponse, status: number, message: string): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { type: "model_proxy_error", message } }));
}

function stripQueryKey(url: URL): string {
	url.searchParams.delete("key");
	return url.search;
}

export async function startModelProxy(
	config: ModelProxyConfig,
	hooks: ModelProxyHooks = {},
): Promise<RunningModelProxy> {
	let billing: PostgresClient | undefined;
	if (config.billing) {
		billing = createPostgresClient({
			url: config.billing.url,
			schema: config.billing.schema,
			max: 2,
			applicationName: "pi-model-proxy",
		});
		await ensureBillingSchema(billing);
	}
	const limiter = new RateLimiter(config.rateLimitPerMinute);
	const pendingBilling = new Set<Promise<void>>();
	const record = (event: BillingEvent): void => {
		hooks.onEvent?.(event);
		if (billing === undefined) {
			if (!hooks.onEvent) console.error(`[model-proxy] ${JSON.stringify(event)}`);
			return;
		}
		const write = recordBillingEvent(billing, event)
			.catch((error: unknown) => console.error("[model-proxy] failed to record billing event:", error))
			.finally(() => pendingBilling.delete(write));
		pendingBilling.add(write);
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const startedAt = Date.now();
		const url = new URL(req.url ?? "/", "http://proxy.local");
		if (url.pathname === "/healthz") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({ ok: true, providers: [...config.upstreams.keys()].filter((id) => config.keys.has(id)) }),
			);
			return;
		}
		const match = /^\/v1\/([^/]+)(\/.*)?$/.exec(url.pathname);
		if (!match) throw new ProxyError(404, "Expected /v1/<provider>/<path>");
		const provider = decodeURIComponent(match[1]!);
		const rest = match[2] ?? "";
		const upstream = config.upstreams.get(provider);
		if (!upstream) throw new ProxyError(404, `Unknown provider: ${provider}`);

		const token = presentedToken(req, url);
		if (!token) throw new ProxyError(401, "Missing proxy token");
		const verified = verifyProxyToken(config.secret, token);
		if (!verified.ok) throw new ProxyError(401, `Invalid proxy token: ${verified.reason}`);
		const claims: ProxyTokenClaims = verified.claims;
		const session = headerValue(req, "x-pi-session") ?? claims.session;
		if (session !== claims.session) throw new ProxyError(403, "Token is bound to another session");
		if (!limiter.take(claims.tenant)) throw new ProxyError(429, "Rate limit exceeded for tenant");

		const key = config.keys.get(provider);
		if (!key) throw new ProxyError(502, `No upstream credential configured for provider ${provider}`);

		const body = await readBody(req, config.maxRequestBytes);
		const contentType = headerValue(req, "content-type");
		const model = requestedModel(body, contentType);
		if (!modelAllowed(config.allowModels, provider, model)) {
			throw new ProxyError(403, `Model ${provider}/${model ?? "?"} is not allowed for this deployment`);
		}

		const controller = new AbortController();
		req.on("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		const event: BillingEvent = {
			tenant: claims.tenant,
			session: claims.session,
			...(headerValue(req, "x-pi-operation") ? { operation: headerValue(req, "x-pi-operation") } : {}),
			provider,
			...(model ? { model } : {}),
			status: 0,
			requestBytes: body.length,
			responseBytes: 0,
			durationMs: 0,
			streamed: false,
		};
		let upstreamResponse: Response;
		try {
			upstreamResponse = await fetch(upstreamUrl(upstream, rest, stripQueryKey(url)), {
				method: req.method,
				headers: forwardHeaders(req, upstream, key),
				body: body.length > 0 ? body : undefined,
				signal: controller.signal,
				redirect: "manual",
			});
		} catch (error) {
			event.status = 502;
			event.durationMs = Date.now() - startedAt;
			event.error = error instanceof Error ? error.message : String(error);
			record(event);
			throw new ProxyError(502, `Upstream request failed: ${event.error}`);
		}

		const responseHeaders: Record<string, string> = {};
		upstreamResponse.headers.forEach((value, name) => {
			if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
		});
		const responseType = upstreamResponse.headers.get("content-type") ?? undefined;
		event.status = upstreamResponse.status;
		event.streamed = responseType?.includes("text/event-stream") ?? false;
		res.writeHead(upstreamResponse.status, responseHeaders);

		let captured = "";
		let capturedBytes = 0;
		let responseBytes = 0;
		try {
			if (upstreamResponse.body) {
				for await (const chunk of upstreamResponse.body) {
					responseBytes += chunk.length;
					if (capturedBytes < config.maxUsageCaptureBytes) {
						captured += Buffer.from(chunk).toString("utf8");
						capturedBytes += chunk.length;
					}
					if (!res.write(chunk)) await new Promise<void>((resolve) => res.once("drain", resolve));
				}
			}
			res.end();
		} catch (error) {
			event.error = error instanceof Error ? error.message : String(error);
			res.destroy();
		} finally {
			event.responseBytes = responseBytes;
			event.durationMs = Date.now() - startedAt;
			const usage = extractUsage(upstream.api, responseType, captured);
			if (usage) event.usage = usage;
			record(event);
		}
	};

	const server = createServer((req, res) => {
		handle(req, res).catch((error: unknown) => {
			if (error instanceof ProxyError) {
				writeJsonError(res, error.status, error.message);
				return;
			}
			console.error("[model-proxy] unexpected error:", error);
			writeJsonError(res, 500, "Internal proxy error");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => resolve());
	});
	const address = server.address() as AddressInfo;
	return {
		server,
		port: address.port,
		url: `http://${config.host}:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await Promise.allSettled([...pendingBilling]);
			await billing?.end().catch(() => undefined);
		},
	};
}
