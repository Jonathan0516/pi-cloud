/**
 * Cloud session supervisor: the `mini` server grown into a node.
 *
 * It answers `Sessions` from PostgreSQL, spawns one worker process per session it owns, and routes
 * every other call to that worker. Ownership is the lease table: a session held by another live
 * node is not spawned here but relayed to that node over TCP, and a session whose holder went
 * silent is taken over by the reaper when it still has an operation to finish. Workers stay warm
 * while they have work, not while someone is watching. Agent state never lives here.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type SessionSummary,
	Sessions,
	type SessionsServiceApi,
	Worker,
} from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import { createPeer, type RpcPeer } from "@earendil-works/pi-coding-agent/experimental/mini/shared/rpc";
import type { Connection, Transport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import {
	expireSessionLease,
	PostgresSessionRepo,
	readSessionLease,
	type SessionLease,
} from "@earendil-works/pi-session-backend-postgres";
import { type CloudConfig, workerNodeIdentityToEnv } from "../config.ts";
import { loaderArgsFor, loaderEnvFor } from "../process.ts";
import { CloudWorker, type CloudWorkerStatus } from "../protocol.ts";
import { createSessionClient, ensureSessionSchema, listSessionSummaries, WORKSPACE_CWD } from "../sessions.ts";
import { connectTcp, tcpTransport } from "../transport.ts";
import { planTakeovers } from "./reaper.ts";
import {
	listOrphanedOperations,
	readRecoveryRecords,
	recordTakeoverFailure,
	recordTakeoverSuccess,
} from "./recovery.ts";
import { workerEnvironment } from "./worker-env.ts";
import { sweepWorkspaces } from "./workspaces.ts";

const WORKER_ENTRY = fileURLToPath(new URL("../worker/entry.ts", import.meta.url));
const WORKER_START_TIMEOUT_MS = 60_000;
const IDLE_SHUTDOWN_MS = 10_000;
const STDERR_TAIL_CHARS = 16_000;
/** After SIGTERM, a worker that has not exited is killed. */
const WORKER_STOP_GRACE_MS = 10_000;
/** A taken-over worker still alive this long counts as a successful resume. */
const TAKEOVER_HEALTHY_MS = 15_000;
const REMOTE_ATTACH_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 10_000;
const REAPER_SCAN_LIMIT = 50;

interface LocalRoute {
	sessionId: string;
	worker: RpcPeer;
	pid: number | undefined;
	subscribers: Map<string, RpcPeer>;
	/** When the last presentation left; undefined while someone is attached. */
	idleSince: number | undefined;
	/** Set when the reaper started this worker; cleared once it proved healthy. */
	takeoverStartedAt: number | undefined;
	inspect(): Promise<CloudWorkerStatus>;
	/** Ask the worker to stop; resolves once the process has exited. */
	stop(): Promise<void>;
}

/** What one presentation is attached to: a worker here, or a relay to the owning node. */
type Attachment = { kind: "local"; route: LocalRoute } | { kind: "remote"; peer: RpcPeer; ownerAddr: string };

export interface CloudServerOptions {
	config: CloudConfig;
	/** Local presentation transport (the CLI's unix socket). A pure node may serve TCP only. */
	transport?: Transport;
	/** Retire when no presentation and no worker remain. Defaults to the inverse of `config.nodePersistent`. */
	retireWhenIdle?: boolean;
}

export interface RunningCloudServer {
	readonly nodeId: string;
	/** `host:port` this node advertises in leases and other nodes dial. */
	readonly address: string;
	/** Transport that dials this node's TCP listener. */
	readonly tcp: Transport;
	/** Sessions with a worker on this node. */
	localSessions(): string[];
	/** Resolves when the server has retired and released its listeners. */
	done: Promise<void>;
	/** Ask the server to stop: workers are stopped and the listeners closed. */
	stop(): void;
}

function isLeaseHeldError(error: unknown): boolean {
	return error instanceof Error && /is held by/.test(error.message);
}

function liveOwner(lease: SessionLease | undefined, now = Date.now()): SessionLease | undefined {
	return lease !== undefined && lease.state === "held" && lease.expiresAt > now ? lease : undefined;
}

export async function startCloudServer(options: CloudServerOptions): Promise<RunningCloudServer> {
	const { config } = options;
	const context = BACKGROUND_CONTEXT;
	const node = config.nodeId;
	const retireWhenIdle = options.retireWhenIdle ?? !config.nodePersistent;
	const sql = createSessionClient(config, `pi-cloud-server:${node}`);
	await ensureSessionSchema(sql, config);
	const repo = new PostgresSessionRepo({ sql });
	const log = (message: string): void => console.error(`[node ${node}] ${message}`);

	const tcp = tcpTransport(config.nodeListenHost, config.nodeListenPort);
	const routes = new Map<string, LocalRoute>();
	const spawning = new Map<string, Promise<LocalRoute>>();
	/** Workers told to stop but not yet exited. A new worker for the same session waits for them. */
	const stopping = new Map<string, Promise<void>>();
	const reconciliations = new Set<Promise<void>>();
	let presentations = 0;
	let closing = false;
	let advertise = config.nodeAdvertiseAddr ?? `${config.nodeListenHost}:${config.nodeListenPort}`;
	let retire = (): void => {};
	const retired = new Promise<void>((resolve) => {
		retire = resolve;
	});
	let idleTimer: NodeJS.Timeout | undefined;
	const considerRetiring = (): void => {
		if (!retireWhenIdle) return;
		if (idleTimer) clearTimeout(idleTimer);
		if (presentations > 0 || routes.size > 0) return;
		idleTimer = setTimeout(() => {
			if (presentations === 0 && routes.size === 0) retire();
		}, IDLE_SHUTDOWN_MS);
		idleTimer.unref();
	};

	/**
	 * A worker that exited without releasing its lease leaves one that would otherwise block the
	 * session until the TTL. This node watched the child die, so expiring it now is safe; the taker
	 * still sees an expired predecessor and fences the dead worker's sandbox.
	 */
	const reconcileLease = (sessionId: string, pid: number | undefined): Promise<void> => {
		if (pid === undefined) return Promise.resolve();
		const pending = (async () => {
			try {
				const lease = await readSessionLease(sql, sessionId);
				if (lease === undefined || lease.state !== "held") return;
				if (lease.owner.node !== node || !lease.owner.proc.startsWith(`${pid}:`)) return;
				if (lease.expiresAt <= Date.now()) return;
				if (await expireSessionLease(sql, sessionId, lease.epoch)) {
					log(
						`expired lease epoch ${lease.epoch} of session ${sessionId}: worker ${pid} exited without releasing it`,
					);
				}
			} catch (error) {
				log(`failed to reconcile the lease of session ${sessionId}: ${String(error)}`);
			}
		})().finally(() => reconciliations.delete(pending));
		reconciliations.add(pending);
		return pending;
	};

	const list = (): Promise<SessionSummary[]> => listSessionSummaries(repo, config, context);
	const attachUnsupported = async (): Promise<string> => {
		throw new Error("Only presentations attach to sessions");
	};

	const spawnWorker = async (sessionId: string | undefined, reason: "attach" | "takeover"): Promise<LocalRoute> => {
		// The id is chosen here even for a new session, so the worker's proxy token can be bound to it.
		const id = sessionId ?? uuidv7();
		const startedAt = Date.now();
		const child = spawn(
			process.execPath,
			[...loaderArgsFor(WORKER_ENTRY), WORKER_ENTRY, id, ...(sessionId === undefined ? ["--create"] : [])],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: workerEnvironment(process.env, config, id, {
					...loaderEnvFor(WORKER_ENTRY),
					...workerNodeIdentityToEnv({ node, addr: advertise }),
				}),
			},
		);
		let stderrTail = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			process.stderr.write(chunk);
			stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			child.once("exit", (code, signal) => resolve({ code, signal })),
		);
		void exited.then(() => reconcileLease(id, child.pid));

		const peer = createPeer(
			{
				send: (message) => child.stdin?.write(`${JSON.stringify(message)}\n`),
				onMessage: (handler) => {
					let buffered = "";
					child.stdout?.setEncoding("utf8");
					child.stdout?.on("data", (chunk: string) => {
						buffered += chunk;
						let newline = buffered.indexOf("\n");
						while (newline !== -1) {
							const line = buffered.slice(0, newline);
							buffered = buffered.slice(newline + 1);
							if (line.length > 0) handler(JSON.parse(line));
							newline = buffered.indexOf("\n");
						}
					});
				},
				onClose: (handler) => {
					child.stdout?.once("end", handler);
					child.once("exit", handler);
				},
				close: () => child.kill(),
			},
			{},
		);
		peer.provide(Sessions, { list, attach: attachUnsupported });
		let described: { sessionId: string };
		try {
			described = await peer.use(Worker, { timeoutMs: WORKER_START_TIMEOUT_MS }).describe();
		} catch (error) {
			child.kill();
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Session worker failed to start (${reason})${stderrTail ? `:\n${stderrTail.trim()}` : ""}`);
		}
		const cloud = peer.use(CloudWorker, { timeoutMs: INSPECT_TIMEOUT_MS });
		const stop = (): Promise<void> => {
			const pending = stopping.get(described.sessionId);
			if (pending !== undefined) return pending;
			// A deliberate stop is not a failed resume, however soon after a takeover it happens.
			route.takeoverStartedAt = undefined;
			child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.kill("SIGKILL"), WORKER_STOP_GRACE_MS);
			killTimer.unref();
			const stopped = exited.then(() => clearTimeout(killTimer)).finally(() => stopping.delete(described.sessionId));
			stopping.set(described.sessionId, stopped);
			return stopped;
		};
		const route: LocalRoute = {
			sessionId: described.sessionId,
			worker: peer,
			pid: child.pid,
			subscribers: new Map(),
			idleSince: reason === "takeover" ? Date.now() : undefined,
			takeoverStartedAt: reason === "takeover" ? startedAt : undefined,
			inspect: () => cloud.inspect(),
			stop,
		};
		peer.onEvent((service, payload, to) => {
			if (to !== undefined) {
				route.subscribers.get(to)?.emitRaw(service, payload);
				return;
			}
			for (const subscriber of route.subscribers.values()) subscriber.emitRaw(service, payload);
		});
		void exited.then(({ code, signal }) => {
			if (routes.get(route.sessionId) === route) routes.delete(route.sessionId);
			if (route.takeoverStartedAt !== undefined && Date.now() - route.takeoverStartedAt < TAKEOVER_HEALTHY_MS) {
				const why = `worker exited ${Date.now() - route.takeoverStartedAt}ms after takeover (code ${code}, signal ${signal})`;
				void recordTakeoverFailure(sql, route.sessionId, `${why}\n${stderrTail.trim()}`, config.poisonThreshold)
					.then((record) =>
						log(
							`takeover of ${route.sessionId} failed (${record.failures} failures${record.faulted ? ", now faulted" : ""}): ${why}`,
						),
					)
					.catch((error: unknown) => log(`failed to record takeover failure: ${String(error)}`));
			}
			considerRetiring();
		});
		if (reason === "takeover") {
			const healthy = setTimeout(() => {
				if (routes.get(route.sessionId) !== route) return;
				route.takeoverStartedAt = undefined;
				void recordTakeoverSuccess(sql, route.sessionId).catch(() => undefined);
			}, TAKEOVER_HEALTHY_MS);
			healthy.unref();
		}
		routes.set(route.sessionId, route);
		return route;
	};

	const ensureLocalRoute = async (sessionId: string | null, reason: "attach" | "takeover"): Promise<LocalRoute> => {
		if (sessionId === null) return spawnWorker(undefined, reason);
		const existing = routes.get(sessionId);
		if (existing) {
			// A worker that died an instant ago is still routed until its exit is observed. Asking it
			// first turns that window into a fresh spawn instead of a failed attach.
			try {
				await existing.inspect();
				return existing;
			} catch {
				if (routes.get(sessionId) === existing) routes.delete(sessionId);
			}
		}
		const pending = spawning.get(sessionId);
		if (pending) return pending;
		// The previous worker releases the lease as it exits; spawning before that would only fail on it.
		const started = (stopping.get(sessionId) ?? Promise.resolve())
			.then(() => spawnWorker(sessionId, reason))
			.finally(() => spawning.delete(sessionId));
		spawning.set(sessionId, started);
		return started;
	};

	/** Attach one presentation to the owning node's worker over TCP and relay both directions. */
	const attachRemote = async (
		owner: SessionLease,
		sessionId: string,
		presentationId: string,
		presentation: RpcPeer,
	): Promise<Attachment> => {
		const peer = createPeer(await connectTcp(owner.owner.addr));
		peer.onEvent((service, payload, to) => {
			if (to === undefined || to === presentationId) presentation.emitRaw(service, payload);
		});
		try {
			await peer
				.use(Sessions, { timeoutMs: REMOTE_ATTACH_TIMEOUT_MS })
				.attach(sessionId, WORKSPACE_CWD, presentationId);
		} catch (error) {
			peer.close();
			throw error;
		}
		log(
			`relaying presentation ${presentationId} for session ${sessionId} to ${owner.owner.node} (${owner.owner.addr})`,
		);
		return { kind: "remote", peer, ownerAddr: owner.owner.addr };
	};

	/** Local worker when this node owns or can take the session; otherwise a relay to the live owner. */
	const resolveAttachment = async (
		sessionId: string | null,
		presentationId: string,
		presentation: RpcPeer,
	): Promise<Attachment> => {
		if (sessionId !== null && !routes.has(sessionId) && !spawning.has(sessionId)) {
			const owner = liveOwner(await readSessionLease(sql, sessionId));
			if (owner !== undefined && owner.owner.node !== node) {
				return attachRemote(owner, sessionId, presentationId, presentation);
			}
		}
		try {
			return { kind: "local", route: await ensureLocalRoute(sessionId, "attach") };
		} catch (error) {
			// Lost a race for the lease: another node took it between our read and the worker's acquire.
			if (sessionId === null || !isLeaseHeldError(error)) throw error;
			const owner = liveOwner(await readSessionLease(sql, sessionId));
			if (owner === undefined || owner.owner.node === node) throw error;
			return attachRemote(owner, sessionId, presentationId, presentation);
		}
	};

	/** Stop workers nobody watches once their operation has finished and the grace period passed. */
	const sweepIdleWorkers = async (): Promise<void> => {
		const now = Date.now();
		for (const route of [...routes.values()]) {
			if (route.subscribers.size > 0) continue;
			route.idleSince ??= now;
			let busy = false;
			try {
				busy = (await route.inspect()).busy;
			} catch {
				busy = false;
			}
			if (busy) {
				route.idleSince = Date.now();
				continue;
			}
			if (Date.now() - route.idleSince < config.workerIdleGraceMs) continue;
			if (routes.get(route.sessionId) !== route) continue;
			log(`stopping idle worker for session ${route.sessionId}`);
			routes.delete(route.sessionId);
			void route.stop();
		}
	};

	/**
	 * Take over sessions with an open operation and no live holder. Idle sessions whose lease merely
	 * expired are left alone: nothing needs resuming, and the next presentation takes them lazily.
	 */
	const reap = async (): Promise<void> => {
		if (closing) return;
		const ids = (await listOrphanedOperations(sql, REAPER_SCAN_LIMIT)).filter(
			(sessionId) => !routes.has(sessionId) && !spawning.has(sessionId) && !stopping.has(sessionId),
		);
		if (ids.length === 0) return;
		const records = await readRecoveryRecords(sql, ids);
		const plan = planTakeovers(
			ids.map((sessionId) => ({
				sessionId,
				hasOpenOperation: true,
				failures: records.get(sessionId)?.failures ?? 0,
				faulted: records.get(sessionId)?.faulted ?? false,
			})),
			{ perTick: config.reaperTakeoversPerTick, failureThreshold: config.poisonThreshold },
		);
		if (plan.take.length > 0 || plan.skippedFaulted.length > 0) {
			log(
				`reaper: taking over ${plan.take.length} (deferred ${plan.deferredBudget.length} for budget, ${plan.skippedFaulted.length} faulted)`,
			);
		}
		await Promise.all(
			plan.take.map(async (sessionId) => {
				try {
					await ensureLocalRoute(sessionId, "takeover");
					log(`took over session ${sessionId}`);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					if (isLeaseHeldError(error)) return; // another node won this one
					const record = await recordTakeoverFailure(sql, sessionId, reason, config.poisonThreshold).catch(
						() => undefined,
					);
					log(
						`takeover of ${sessionId} failed (${record?.failures ?? "?"} failures${record?.faulted ? ", now faulted" : ""}): ${reason.split("\n")[0]}`,
					);
				}
			}),
		);
	};

	const onPresentation = (connection: Connection): void => {
		presentations += 1;
		let attachment: Attachment | undefined;
		let attachedAs: string | undefined;
		const detach = (): void => {
			if (attachment === undefined || attachedAs === undefined) return;
			if (attachment.kind === "local") {
				attachment.route.subscribers.delete(attachedAs);
				if (attachment.route.subscribers.size === 0) attachment.route.idleSince = Date.now();
			} else {
				attachment.peer.close();
			}
			attachment = undefined;
		};
		const sessions: SessionsServiceApi = {
			list,
			// The presentation's cwd is ignored: every cloud session works in the sandbox workspace.
			attach: async (sessionId, _cwd, presentationId) => {
				detach();
				attachedAs = presentationId;
				const resolved = await resolveAttachment(sessionId, presentationId, presentation);
				attachment = resolved;
				if (resolved.kind === "local") {
					resolved.route.subscribers.set(presentationId, presentation);
					resolved.route.idleSince = undefined;
					return resolved.route.sessionId;
				}
				return sessionId as string;
			},
		};
		const presentation: RpcPeer = createPeer(connection, {
			forward: (method, args) => {
				if (!attachment) throw new Error("Not attached to a session");
				if (attachment.kind === "remote") return attachment.peer.call(method, ...args);
				const service = method.slice(0, method.indexOf("."));
				if (!attachment.route.worker.announced.has(service)) {
					throw new Error(
						`No host provides ${service}: server has [${[...presentation.provided]}], worker has [${[...attachment.route.worker.announced]}]`,
					);
				}
				return attachment.route.worker.call(method, ...args);
			},
		});
		presentation.provide(Sessions, sessions);
		connection.onClose(() => {
			presentations -= 1;
			detach();
			considerRetiring();
		});
	};

	const tcpListener = await tcp.listen(onPresentation);
	if (config.nodeAdvertiseAddr === undefined) advertise = `${config.nodeListenHost}:${tcpListener.port}`;
	const localListener = options.transport === undefined ? undefined : await options.transport.listen(onPresentation);
	log(`listening on ${advertise}${options.transport ? " and the local socket" : ""}`);

	const sweepInterval = Math.max(1_000, Math.min(5_000, Math.floor(config.workerIdleGraceMs / 3) || 1_000));
	const sweepTimer = setInterval(() => void sweepIdleWorkers(), sweepInterval);
	sweepTimer.unref();
	let reapInFlight = false;
	const reapTimer =
		config.reaperIntervalMs > 0
			? setInterval(() => {
					if (reapInFlight) return;
					reapInFlight = true;
					void reap()
						.catch((error: unknown) => log(`reaper failed: ${String(error)}`))
						.finally(() => {
							reapInFlight = false;
						});
				}, config.reaperIntervalMs)
			: undefined;
	reapTimer?.unref();

	// Workspaces outlive their sandboxes by design, so something has to reclaim them. Runs on its
	// own slow cadence; a sweep never touches a directory whose session a worker still holds.
	const gcIntervalMs = config.workspaceRetentionDays === 0 ? 0 : config.workspaceGcIntervalMs;
	let gcInFlight = false;
	const runWorkspaceGc = (): void => {
		if (gcInFlight || closing) return;
		gcInFlight = true;
		void sweepWorkspaces(sql, {
			workspacesRoot: config.workspacesRoot,
			retentionMs: config.workspaceRetentionDays * 86_400_000,
			log,
		})
			.then((removed) => {
				if (removed.length > 0) log(`reclaimed ${removed.length} workspace(s)`);
			})
			.catch((error: unknown) => log(`workspace sweep failed: ${String(error)}`))
			.finally(() => {
				gcInFlight = false;
			});
	};
	const gcTimer = gcIntervalMs > 0 ? setInterval(runWorkspaceGc, gcIntervalMs) : undefined;
	gcTimer?.unref();
	// One sweep at start clears what a previous run of this node left behind.
	if (gcIntervalMs > 0) setTimeout(runWorkspaceGc, 5_000).unref();

	considerRetiring();
	const done = retired.then(async () => {
		closing = true;
		clearInterval(sweepTimer);
		if (reapTimer) clearInterval(reapTimer);
		if (gcTimer) clearInterval(gcTimer);
		await Promise.all([...routes.values()].map((route) => route.stop()));
		// Workers already told to stop must finish exiting before the database client goes away,
		// because their exit triggers a lease reconciliation.
		await Promise.allSettled([...stopping.values()]);
		const closeAll = Promise.all([tcpListener.close(), localListener?.close() ?? Promise.resolve()]);
		// A presentation that never disconnects must not pin the process; bound the wait.
		await Promise.race([closeAll, new Promise((resolve) => setTimeout(resolve, 5_000))]);
		await Promise.allSettled([...reconciliations]);
		await repo.close(context).catch(() => undefined);
		await sql.end().catch(() => undefined);
	});
	return {
		nodeId: node,
		address: advertise,
		tcp: tcpTransport(config.nodeListenHost, tcpListener.port),
		localSessions: () => [...routes.keys()],
		done,
		stop: () => retire(),
	};
}

/** Run the server until it retires. */
export async function runCloudServer(options: CloudServerOptions): Promise<void> {
	const server = await startCloudServer(options);
	await server.done;
}
