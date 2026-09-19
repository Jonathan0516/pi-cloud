/**
 * The gateway process: HTTP for the management surface, WebSocket for presentations.
 *
 *   GET    /healthz
 *   GET    /v1/me                      who the key belongs to
 *   GET    /v1/sessions                the caller's tenant's sessions, newest first
 *   POST   /v1/sessions   {title?}     create (no worker is started; the first attach does that)
 *   GET    /v1/sessions/:id
 *   DELETE /v1/sessions/:id            409 while a worker holds the session
 *   GET    /v1/bundles                 the tenant's resource bundles
 *   POST   /v1/bundles   {files, setDefault?}   publish (files: path → text, or base64 with encoding)
 *   GET    /v1/bundles/:version        one bundle's manifest
 *   GET    /v1/tenant/bundle           the tenant's current default, 404 when none
 *   PUT    /v1/tenant/bundle {version} set the default new sessions are pinned to
 *   DELETE /v1/tenant/bundle           clear it
 *   GET    /v1/ws                      WebSocket upgrade: the mini RPC, relayed to the owning node
 *   GET    /, /<asset>                 the built web client, when PI_GATEWAY_WEB_DIR is set
 *
 * Every route except /healthz needs `Authorization: Bearer <key>`; the WebSocket also accepts the
 * key as the `bearer.<key>` subprotocol. TLS terminates in front of this process.
 */

import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
	type BundleFiles,
	BundleValidationError,
	clearTenantBundle,
	ensureSessionSchema,
	isBundleVersion,
	listBundles,
	MAX_BUNDLE_BYTES,
	publishBundle,
	readBundle,
	type StoredBundle,
	setTenantBundle,
	tenantDefaultBundle,
} from "@earendil-works/pi-cloud-worker";
import { createPostgresClient, type PostgresClient } from "@earendil-works/pi-session-backend-postgres";
import { WebSocketServer } from "ws";
import { authenticateApiKey, bearerToken, ensureAuthSchema, installApiKey, type Principal } from "./auth.ts";
import {
	createTenantSession,
	deleteTenantSession,
	describeSession,
	ensureCatalogSchema,
	findTenantSession,
	listTenantSessions,
	SessionBusyError,
} from "./catalog.ts";
import type { GatewayConfig } from "./config.ts";
import { relayPresentation } from "./relay.ts";
import { bearerFromProtocols, serverWebSocketConnection, WS_PROTOCOL } from "./ws.ts";

const MAX_BODY_BYTES = 64 * 1024;
/** Bundle files travel base64 or raw text inside JSON; allow for the encoding overhead. */
const MAX_BUNDLE_BODY_BYTES = MAX_BUNDLE_BYTES * 2;

export interface RunningGateway {
	readonly server: Server;
	readonly port: number;
	readonly url: string;
	readonly sql: PostgresClient;
	close(): Promise<void>;
}

export interface GatewayHooks {
	log?: (message: string) => void;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function json(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
	});
	response.end(payload);
}

function readJsonBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, "Request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					reject(new HttpError(400, "Request body must be a JSON object"));
					return;
				}
				resolve(parsed as Record<string, unknown>);
			} catch {
				reject(new HttpError(400, "Request body is not valid JSON"));
			}
		});
		request.on("error", reject);
	});
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function bundleView(bundle: StoredBundle): Record<string, unknown> {
	return {
		version: bundle.version,
		tenant: bundle.tenant,
		size: bundle.size,
		createdAt: bundle.createdAt.toISOString(),
		files: bundle.manifest.files,
		registers: bundle.manifest.registers,
	};
}

/** `{ files: { "skills/x/SKILL.md": "..." }, encoding?: "utf8" | "base64" }` → bytes per path. */
function bundleFilesFromBody(body: Record<string, unknown>): BundleFiles {
	const raw = body.files;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new HttpError(400, "files must be an object of path → content");
	const encoding = body.encoding ?? "utf8";
	if (encoding !== "utf8" && encoding !== "base64") throw new HttpError(400, "encoding must be utf8 or base64");
	const files = new Map<string, Uint8Array>();
	for (const [path, content] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof content !== "string") throw new HttpError(400, `files[${JSON.stringify(path)}] must be a string`);
		files.set(path, new Uint8Array(Buffer.from(content, encoding)));
	}
	return files;
}
const STATIC_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

/** Serve one file from the web directory; `/` is index.html. Paths outside the directory are 404. */
async function serveStatic(webDir: string, pathname: string, response: ServerResponse): Promise<boolean> {
	const root = resolve(webDir);
	const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
	const target = normalize(join(root, relative));
	if (target !== root && !target.startsWith(root + sep)) return false;
	const type = STATIC_TYPES[extname(target)];
	if (type === undefined) return false;
	let body: Buffer;
	try {
		if (!(await stat(target)).isFile()) return false;
		body = await readFile(target);
	} catch {
		return false;
	}
	response.writeHead(200, {
		"content-type": type,
		"content-length": body.byteLength,
		"cache-control": extname(target) === ".html" ? "no-cache" : "public, max-age=300",
	});
	response.end(body);
	return true;
}

/** Set up the schema (the node's tables plus the gateway's) and install bootstrap keys. */
export async function prepareGatewayDatabase(sql: PostgresClient, config: GatewayConfig): Promise<void> {
	await ensureSessionSchema(sql, { schema: config.schema });
	await sql.begin(async (transaction) => {
		await transaction`SELECT pg_advisory_xact_lock(hashtext(${`pi-cloud-gateway-schema:${config.schema}`}))`;
		await ensureAuthSchema(transaction);
		await ensureCatalogSchema(transaction);
	});
	for (const entry of config.bootstrapKeys) {
		await installApiKey(sql, entry.key, { tenant: entry.tenant, user: entry.user });
	}
}

export async function startGateway(config: GatewayConfig, hooks: GatewayHooks = {}): Promise<RunningGateway> {
	const log = hooks.log ?? ((message: string) => console.error(`[gateway] ${message}`));
	const sql = createPostgresClient({
		url: config.databaseUrl,
		schema: config.schema,
		max: 8,
		applicationName: "pi-cloud-gateway",
	});
	await prepareGatewayDatabase(sql, config);
	const context = BACKGROUND_CONTEXT;
	const relayOptions = {
		sql,
		schema: config.schema,
		nodes: config.nodes,
		nodeConnectTimeoutMs: config.nodeConnectTimeoutMs,
		log,
	};

	const authenticate = async (request: IncomingMessage): Promise<Principal> => {
		const key =
			bearerToken(request.headers.authorization) ?? bearerFromProtocols(request.headers["sec-websocket-protocol"]);
		if (key === undefined) throw new HttpError(401, "Missing API key");
		const principal = await authenticateApiKey(sql, key);
		if (principal === undefined) throw new HttpError(401, "Invalid API key");
		return principal;
	};

	const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", "http://gateway");
		const method = request.method ?? "GET";
		if (url.pathname === "/healthz") {
			json(response, 200, { ok: true });
			return;
		}
		if (config.webDir !== undefined && method === "GET" && !url.pathname.startsWith("/v1/")) {
			if (await serveStatic(config.webDir, url.pathname, response)) return;
			throw new HttpError(404, "Not found");
		}
		const principal = await authenticate(request);
		if (url.pathname === "/v1/me" && method === "GET") {
			json(response, 200, principal);
			return;
		}
		if (url.pathname === "/v1/sessions") {
			if (method === "GET") {
				const sessions = await listTenantSessions(sql, principal.tenant);
				json(response, 200, {
					sessions: await Promise.all(sessions.map((session) => describeSession(sql, config.schema, session))),
				});
				return;
			}
			if (method === "POST") {
				const body = await readJsonBody(request);
				const title = body.title;
				if (title !== undefined && (typeof title !== "string" || title.length > 200)) {
					throw new HttpError(400, "title must be a string of at most 200 characters");
				}
				const session = await createTenantSession(sql, principal, title === undefined ? {} : { title }, context);
				json(response, 201, await describeSession(sql, config.schema, session));
				return;
			}
			throw new HttpError(405, "Method not allowed");
		}
		if (url.pathname === "/v1/bundles") {
			if (method === "GET") {
				json(response, 200, { bundles: (await listBundles(sql, principal.tenant)).map(bundleView) });
				return;
			}
			if (method === "POST") {
				const body = await readJsonBody(request, MAX_BUNDLE_BODY_BYTES);
				let published: Awaited<ReturnType<typeof publishBundle>>;
				try {
					published = await publishBundle(sql, principal.tenant, bundleFilesFromBody(body));
					if (body.setDefault === true) await setTenantBundle(sql, principal.tenant, published.bundle.version);
				} catch (error) {
					if (error instanceof BundleValidationError) throw new HttpError(400, error.message);
					throw error;
				}
				json(response, published.created ? 201 : 200, {
					...bundleView(published.bundle),
					created: published.created,
				});
				return;
			}
			throw new HttpError(405, "Method not allowed");
		}
		const bundleMatch = /^\/v1\/bundles\/([^/]+)$/.exec(url.pathname);
		if (bundleMatch) {
			if (method !== "GET") throw new HttpError(405, "Method not allowed");
			const version = bundleMatch[1]!;
			const bundle = isBundleVersion(version) ? await readBundle(sql, version) : undefined;
			if (bundle === undefined || bundle.tenant !== principal.tenant) throw new HttpError(404, "Unknown bundle");
			json(response, 200, bundleView(bundle));
			return;
		}
		if (url.pathname === "/v1/tenant/bundle") {
			if (method === "GET") {
				const bundle = await tenantDefaultBundle(sql, principal.tenant);
				if (bundle === undefined) throw new HttpError(404, "No default bundle");
				json(response, 200, bundleView(bundle));
				return;
			}
			if (method === "PUT") {
				const body = await readJsonBody(request);
				if (typeof body.version !== "string" || !isBundleVersion(body.version))
					throw new HttpError(400, "version must be a bundle version");
				try {
					json(response, 200, bundleView(await setTenantBundle(sql, principal.tenant, body.version)));
				} catch (error) {
					if (error instanceof BundleValidationError) throw new HttpError(404, "Unknown bundle");
					throw error;
				}
				return;
			}
			if (method === "DELETE") {
				await clearTenantBundle(sql, principal.tenant);
				response.writeHead(204).end();
				return;
			}
			throw new HttpError(405, "Method not allowed");
		}
		const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
		if (sessionMatch) {
			const id = decodeURIComponent(sessionMatch[1]!);
			if (!SESSION_ID.test(id)) throw new HttpError(404, "Unknown session");
			if (method === "GET") {
				const session = await findTenantSession(sql, principal.tenant, id);
				if (session === undefined) throw new HttpError(404, "Unknown session");
				json(response, 200, await describeSession(sql, config.schema, session));
				return;
			}
			if (method === "DELETE") {
				let deleted: boolean;
				try {
					deleted = await deleteTenantSession(sql, principal.tenant, id, context);
				} catch (error) {
					if (error instanceof SessionBusyError) throw new HttpError(409, error.message);
					throw error;
				}
				if (!deleted) throw new HttpError(404, "Unknown session");
				response.writeHead(204).end();
				return;
			}
			throw new HttpError(405, "Method not allowed");
		}
		throw new HttpError(404, "Not found");
	};

	const server = createServer((request, response) => {
		route(request, response).catch((error: unknown) => {
			if (error instanceof HttpError) {
				json(response, error.status, { error: error.message });
				return;
			}
			log(`request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			if (!response.headersSent) json(response, 500, { error: "Internal error" });
			else response.destroy();
		});
	});

	const websockets = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
	});
	const rejectUpgrade = (socket: Duplex, status: number, message: string): void => {
		const body = JSON.stringify({ error: message });
		socket.write(
			`HTTP/1.1 ${status} ${message}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
		);
		socket.destroy();
	};
	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url ?? "/", "http://gateway");
		if (url.pathname !== "/v1/ws") {
			rejectUpgrade(socket, 404, "Not found");
			return;
		}
		authenticate(request).then(
			(principal) => {
				websockets.handleUpgrade(request, socket, head, (ws) => {
					relayPresentation(serverWebSocketConnection(ws), principal, relayOptions);
				});
			},
			(error: unknown) => {
				if (error instanceof HttpError) rejectUpgrade(socket, error.status, error.message);
				else {
					log(`upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
					rejectUpgrade(socket, 500, "Internal error");
				}
			},
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : config.port;
	const url = `http://${config.host}:${port}`;
	log(
		`listening on ${url}; nodes ${config.nodes.join(", ")}${config.webDir ? `; web client from ${config.webDir}` : ""}`,
	);
	return {
		server,
		port,
		url,
		sql,
		close: async () => {
			for (const client of websockets.clients) client.terminate();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			await sql.end().catch(() => undefined);
		},
	};
}
