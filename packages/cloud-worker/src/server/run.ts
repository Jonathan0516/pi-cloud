/**
 * Cloud session server: the `mini` server with PostgreSQL as the session catalog.
 *
 * It answers `Sessions` from the database, spawns one worker process per session, and routes every
 * other service call to the worker the presentation is attached to. Agent state never lives here.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
	type SessionSummary,
	Sessions,
	type SessionsServiceApi,
	Worker,
} from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import { createPeer, type RpcPeer } from "@earendil-works/pi-coding-agent/experimental/mini/shared/rpc";
import { childConnection, type Transport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { expireSessionLease, PostgresSessionRepo, readSessionLease } from "@earendil-works/pi-session-backend-postgres";
import { type CloudConfig, cloudConfigToEnv } from "../config.ts";
import { loaderArgsFor, loaderEnvFor } from "../process.ts";
import { createSessionClient, ensureSessionSchema, listSessionSummaries } from "../sessions.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../worker/entry.ts", import.meta.url));
const WORKER_START_TIMEOUT_MS = 60_000;
const IDLE_SHUTDOWN_MS = 10_000;
const STDERR_TAIL_CHARS = 16_000;
/** After SIGTERM, a worker that has not exited is killed. */
const WORKER_STOP_GRACE_MS = 10_000;

interface Route {
	sessionId: string;
	worker: RpcPeer;
	subscribers: Map<string, RpcPeer>;
	/** Ask the worker to stop; resolves once the process has exited. */
	stop(): Promise<void>;
}

export interface CloudServerOptions {
	transport: Transport;
	config: CloudConfig;
	/** Retire when no presentation and no worker remain. Defaults to true, matching `mini`. */
	retireWhenIdle?: boolean;
}

export interface RunningCloudServer {
	/** Resolves when the server has retired and released its listener. */
	done: Promise<void>;
	/** Ask the server to stop: workers are stopped and the listener closed. */
	stop(): void;
}

export async function startCloudServer(options: CloudServerOptions): Promise<RunningCloudServer> {
	const { config } = options;
	const context = BACKGROUND_CONTEXT;
	const sql = createSessionClient(config, "pi-cloud-server");
	await ensureSessionSchema(sql, config);
	const repo = new PostgresSessionRepo({ sql });

	const routes = new Map<string, Route>();
	const spawning = new Map<string, Promise<Route>>();
	/** Workers told to stop but not yet exited. A new worker for the same session waits for them. */
	const stopping = new Map<string, Promise<void>>();
	const node = hostname();

	/**
	 * A worker that exited without releasing its lease (crash, SIGKILL, stop grace exceeded) leaves
	 * a lease that would otherwise block the session until the TTL. This process watched the child
	 * die, so expiring that lease now is safe; the taker still sees an expired predecessor and fences
	 * the dead worker's sandbox.
	 */
	const reconcileLease = async (sessionId: string, pid: number | undefined): Promise<void> => {
		if (pid === undefined) return;
		try {
			const lease = await readSessionLease(sql, sessionId);
			if (lease === undefined || lease.state !== "held") return;
			if (lease.owner.node !== node || !lease.owner.proc.startsWith(`${pid}:`)) return;
			if (lease.expiresAt <= Date.now()) return;
			if (await expireSessionLease(sql, sessionId, lease.epoch)) {
				console.error(
					`Expired lease epoch ${lease.epoch} of session ${sessionId}: worker ${pid} exited without releasing it`,
				);
			}
		} catch (error) {
			console.error(`Failed to reconcile the lease of session ${sessionId}:`, error);
		}
	};
	let presentations = 0;
	let retire = (): void => {};
	const retired = new Promise<void>((resolve) => {
		retire = resolve;
	});
	let idleTimer: NodeJS.Timeout | undefined;
	const considerRetiring = (): void => {
		if (options.retireWhenIdle === false) return;
		if (idleTimer) clearTimeout(idleTimer);
		if (presentations > 0 || routes.size > 0) return;
		idleTimer = setTimeout(() => {
			if (presentations === 0 && routes.size === 0) retire();
		}, IDLE_SHUTDOWN_MS);
		idleTimer.unref();
	};

	const list = (): Promise<SessionSummary[]> => listSessionSummaries(repo, config, context);
	const attachUnsupported = async (): Promise<string> => {
		throw new Error("Only presentations attach to sessions");
	};

	const spawnWorker = async (sessionId: string | undefined): Promise<Route> => {
		const child = spawn(
			process.execPath,
			[...loaderArgsFor(WORKER_ENTRY), WORKER_ENTRY, ...(sessionId ? [sessionId] : [])],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, ...cloudConfigToEnv(config), ...loaderEnvFor(WORKER_ENTRY) },
			},
		);
		// Keep the tail of the worker's stderr so a worker that dies before describing itself explains why.
		let stderrTail = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			process.stderr.write(chunk);
			stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
		});
		const peer = createPeer(childConnection(child));
		peer.provide(Sessions, { list, attach: attachUnsupported });
		let described: { sessionId: string };
		try {
			described = await peer.use(Worker, { timeoutMs: WORKER_START_TIMEOUT_MS }).describe();
		} catch (error) {
			child.kill();
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Session worker failed to start (${reason})${stderrTail ? `:\n${stderrTail.trim()}` : ""}`);
		}
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const stop = (): Promise<void> => {
			const pending = stopping.get(described.sessionId);
			if (pending !== undefined) return pending;
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.kill("SIGKILL"), WORKER_STOP_GRACE_MS);
			killTimer.unref();
			const stopped = exited.then(() => clearTimeout(killTimer)).finally(() => stopping.delete(described.sessionId));
			stopping.set(described.sessionId, stopped);
			return stopped;
		};
		const route: Route = {
			sessionId: described.sessionId,
			worker: peer,
			subscribers: new Map(),
			stop,
		};
		void exited.then(() => reconcileLease(described.sessionId, child.pid));
		peer.onEvent((service, payload, to) => {
			if (to !== undefined) {
				route.subscribers.get(to)?.emitRaw(service, payload);
				return;
			}
			for (const subscriber of route.subscribers.values()) subscriber.emitRaw(service, payload);
		});
		peer.onClose(() => {
			routes.delete(route.sessionId);
			considerRetiring();
		});
		routes.set(route.sessionId, route);
		return route;
	};

	const ensureRoute = (sessionId: string | null): Promise<Route> => {
		if (sessionId === null) return spawnWorker(undefined);
		const existing = routes.get(sessionId);
		if (existing) return Promise.resolve(existing);
		const pending = spawning.get(sessionId);
		if (pending) return pending;
		// The previous worker releases the lease as it exits; spawning before that would only fail on it.
		const started = (stopping.get(sessionId) ?? Promise.resolve())
			.then(() => spawnWorker(sessionId))
			.finally(() => spawning.delete(sessionId));
		spawning.set(sessionId, started);
		return started;
	};

	const listener = await options.transport.listen((connection) => {
		presentations += 1;
		let route: Route | undefined;
		let attachedAs: string | undefined;
		const sessions: SessionsServiceApi = {
			list,
			// The presentation's cwd is ignored: every cloud session works in the sandbox workspace.
			attach: async (sessionId, _cwd, presentationId) => {
				route?.subscribers.delete(attachedAs ?? "");
				attachedAs = presentationId;
				route = await ensureRoute(sessionId);
				route.subscribers.set(presentationId, presentation);
				return route.sessionId;
			},
		};
		const presentation: RpcPeer = createPeer(connection, {
			forward: (method, args) => {
				if (!route) throw new Error("Not attached to a session");
				const service = method.slice(0, method.indexOf("."));
				if (!route.worker.announced.has(service)) {
					throw new Error(
						`No host provides ${service}: server has [${[...presentation.provided]}], worker has [${[...route.worker.announced]}]`,
					);
				}
				return route.worker.call(method, ...args);
			},
		});
		presentation.provide(Sessions, sessions);
		connection.onClose(() => {
			presentations -= 1;
			if (route && attachedAs !== undefined) {
				route.subscribers.delete(attachedAs);
				if (route.subscribers.size === 0) {
					// Forget the route before the worker has exited: a presentation that reattaches right away
					// must get a fresh worker, not a call into a process that is being killed.
					routes.delete(route.sessionId);
					void route.stop();
				}
			}
			considerRetiring();
		});
	});

	considerRetiring();
	const done = retired.then(async () => {
		await Promise.all([...routes.values()].map((route) => route.stop()));
		// A presentation that never disconnects must not pin the process; bound the wait.
		await Promise.race([listener.close(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
		await repo.close(context).catch(() => undefined);
		await sql.end().catch(() => undefined);
	});
	return { done, stop: () => retire() };
}

/** Run the server until it retires. */
export async function runCloudServer(options: CloudServerOptions): Promise<void> {
	const server = await startCloudServer(options);
	await server.done;
}
