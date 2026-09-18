import type {
	Context,
	Entry,
	ForkOptions,
	SessionCreateOptions,
	SessionRepo,
	StoredValue,
} from "@earendil-works/pi-agent-core";
import { createForkSnapshot, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	acquireSessionLease,
	FencedError,
	heartbeatSessionLeases,
	type LeaseOwner,
	type OpenSessionLease,
	releaseSessionLease,
	SessionLeaseHeldError,
} from "./lease.ts";
import { appendEntryToBranchIndex } from "./session/branch-entries.ts";
import { insertEntryRow } from "./session/entries.ts";
import {
	deleteSessionRows,
	hasSessionRow,
	insertSessionRow,
	metadataFromSessionRow,
	type PostgresSessionMetadata,
	readAllSessionRows,
	readSessionRow,
} from "./session/session-row.ts";
import { updateMessageCount } from "./session/session-stats.ts";
import { setScalarValueRow } from "./session/values.ts";
import { PostgresOpenSession } from "./session.ts";
import { PostgresStorage, type PostgresStorageSnapshot, readForkSource } from "./storage.ts";
import type { PostgresClient, PostgresQueryable } from "./types.ts";

export const POSTGRES_STORAGE_VERSION = 1;
export const DEFAULT_LEASE_TTL_SECONDS = 30;
export const DEFAULT_LEASE_HEARTBEAT_MS = 5_000;

const FIRST_AVAILABLE_COMMIT_SEQ = 1;
const READ_ONLY_SNAPSHOT = "ISOLATION LEVEL REPEATABLE READ READ ONLY";

export type PostgresSessionCreateOptions = SessionCreateOptions;

/** Cross-process ownership. Without it the repository only guards against double opens in this process. */
export interface PostgresSessionLeaseOptions {
	owner: LeaseOwner;
	/** Seconds a lease stays valid without a renewal. Defaults to 30. */
	ttlSeconds?: number;
	/**
	 * Interval of the batched heartbeat that renews every held lease. Defaults to 5000. `0` disables
	 * the heartbeat; commits still renew, so only idle sessions then expire.
	 */
	heartbeatIntervalMs?: number;
	/** A session this repository held was taken over. Its storage rejects further commits; the host should exit. */
	onFenced?: (sessionId: string, error: FencedError) => void;
	/** A heartbeat query failed. Transient: the next tick retries; the fence catches a real takeover. */
	onHeartbeatError?: (error: unknown) => void;
}

export interface PostgresSessionRepoOptions {
	/**
	 * Client whose `search_path` resolves the session tables (see `createPostgresClient`). The
	 * repository does not own it: closing the repository leaves the client open.
	 */
	sql: PostgresClient;
	now?: () => number;
	lease?: PostgresSessionLeaseOptions;
}

interface ForkSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	messageCount: number;
	nextSeq: number;
}

interface HeldLease {
	epoch: number;
	storage: PostgresStorage;
}

function buildForkSnapshot(source: PostgresStorageSnapshot, options: ForkOptions): ForkSnapshot {
	const snapshot = createForkSnapshot(
		{
			entries: source.entries,
			scalarValues: source.scalarValues,
			entriesComplete: source.entriesComplete,
		},
		options,
	);
	const entries = [...snapshot.entries.values()].sort((left, right) => left.seq - right.seq);
	return {
		entries,
		scalarValues: snapshot.scalarValues,
		messageCount: entries.filter((entry) => entry.type === "message").length,
		nextSeq: snapshot.nextSeq,
	};
}

async function writeForkDestination(
	sql: PostgresQueryable,
	metadata: PostgresSessionMetadata,
	snapshot: ForkSnapshot,
): Promise<void> {
	if (await hasSessionRow(sql, metadata.id)) throw new Error(`PostgreSQL session already exists: ${metadata.id}`);
	await insertSessionRow(sql, metadata, POSTGRES_STORAGE_VERSION, snapshot.nextSeq);
	for (const entry of snapshot.entries) {
		await insertEntryRow(sql, metadata.id, entry);
		await appendEntryToBranchIndex(sql, metadata.id, entry);
	}
	for (const stored of snapshot.scalarValues) {
		await setScalarValueRow(sql, metadata.id, stored.address.namespace, stored.address.key, stored.seq, stored.value);
	}
	await updateMessageCount(sql, metadata.id, snapshot.messageCount);
}

/**
 * Session repository over one PostgreSQL schema. Any number of sessions share the schema; every
 * row is scoped by session id.
 *
 * With `lease` configured, opening a session acquires its lease, every commit renews and fences on
 * it inside the commit transaction, a batched heartbeat renews idle sessions, and closing releases
 * it. A session whose lease another live process holds cannot be opened; one whose holder went
 * silent past the TTL is taken over. Without `lease`, the repository only rejects overlapping local
 * create/open/fork/delete for one id, and the host lifecycle guarantees one writable owner.
 */
export class PostgresSessionRepo implements SessionRepo<PostgresSessionMetadata> {
	private readonly sql: PostgresClient;
	private readonly now: () => number;
	private readonly lease: Required<Pick<PostgresSessionLeaseOptions, "ttlSeconds" | "heartbeatIntervalMs">> &
		PostgresSessionLeaseOptions;
	private readonly leaseEnabled: boolean;
	private readonly pendingIds = new Set<string>();
	private readonly openStorages = new Map<string, PostgresStorage>();
	private readonly openSessions = new Set<PostgresOpenSession>();
	private readonly held = new Map<string, HeldLease>();
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private heartbeatInFlight = false;
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: PostgresSessionRepoOptions) {
		this.sql = options.sql;
		this.now = options.now ?? Date.now;
		this.leaseEnabled = options.lease !== undefined;
		this.lease = {
			owner: options.lease?.owner ?? { node: "", addr: "", proc: "" },
			ttlSeconds: options.lease?.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS,
			heartbeatIntervalMs: options.lease?.heartbeatIntervalMs ?? DEFAULT_LEASE_HEARTBEAT_MS,
			...(options.lease?.onFenced === undefined ? {} : { onFenced: options.lease.onFenced }),
			...(options.lease?.onHeartbeatError === undefined ? {} : { onHeartbeatError: options.lease.onHeartbeatError }),
		};
	}

	/** Sessions this repository currently holds a lease for. */
	get heldSessionIds(): string[] {
		return [...this.held.keys()];
	}

	async create(options: PostgresSessionCreateOptions | undefined, _context: Context): Promise<PostgresOpenSession> {
		this.assertOpen();
		options ??= {};
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		let session: PostgresOpenSession | undefined;
		try {
			const metadata: PostgresSessionMetadata = {
				id,
				createdAt,
				storageVersion: POSTGRES_STORAGE_VERSION,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			};
			const lease = await this.sql.begin(async (transaction) => {
				if (await hasSessionRow(transaction, id)) throw new Error(`PostgreSQL session already exists: ${id}`);
				await insertSessionRow(transaction, metadata, POSTGRES_STORAGE_VERSION, FIRST_AVAILABLE_COMMIT_SEQ);
				return this.acquireLease(transaction, id);
			});
			session = this.openStorageBackedSession(metadata, lease);
			return session;
		} finally {
			if (session === undefined) this.pendingIds.delete(id);
		}
	}

	async open(metadata: PostgresSessionMetadata, _context: Context): Promise<PostgresOpenSession> {
		this.assertOpen();
		this.reserveId(metadata.id);
		let session: PostgresOpenSession | undefined;
		let lease: OpenSessionLease | undefined;
		try {
			const stored = metadataFromSessionRow(await readSessionRow(this.sql, metadata.id), POSTGRES_STORAGE_VERSION);
			lease = await this.acquireLease(this.sql, metadata.id);
			session = this.openStorageBackedSession(stored, lease);
			return session;
		} finally {
			if (session === undefined) {
				this.pendingIds.delete(metadata.id);
				if (lease !== undefined) await releaseSessionLease(this.sql, metadata.id, lease.epoch).catch(() => false);
			}
		}
	}

	async list(_options: undefined, _context: Context): Promise<PostgresSessionMetadata[]> {
		this.assertOpen();
		const sessions: PostgresSessionMetadata[] = [];
		for (const row of await readAllSessionRows(this.sql)) {
			try {
				sessions.push(metadataFromSessionRow(row, POSTGRES_STORAGE_VERSION));
			} catch {
				// Discovery is best-effort: rows at incompatible storage versions are reported when opened.
			}
		}
		return sessions;
	}

	async delete(metadata: PostgresSessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		this.reserveId(metadata.id);
		try {
			metadataFromSessionRow(await readSessionRow(this.sql, metadata.id), POSTGRES_STORAGE_VERSION);
			// Deleting is a write like any other: it requires the lease, so a live worker's session cannot vanish.
			await this.acquireLease(this.sql, metadata.id);
			await this.sql.begin(async (transaction) => {
				metadataFromSessionRow(
					await readSessionRow(transaction, metadata.id, { forUpdate: true }),
					POSTGRES_STORAGE_VERSION,
				);
				await deleteSessionRows(transaction, metadata.id);
			});
		} finally {
			this.pendingIds.delete(metadata.id);
		}
	}

	async fork(source: PostgresSessionMetadata, options: ForkOptions, context: Context): Promise<PostgresOpenSession> {
		this.assertOpen();
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		// A source open in this repository snapshots on its own commit queue so the fork lands on a
		// commit boundary. Any other source is read in one read-only transaction; reading needs no lease.
		const activeSourceSnapshot = this.openStorages.get(source.id)?.snapshot(options, context);
		void activeSourceSnapshot?.catch(() => undefined);
		let session: PostgresOpenSession | undefined;
		try {
			const snapshot = buildForkSnapshot(
				activeSourceSnapshot === undefined
					? await this.readForkSourceFromDatabase(source, options)
					: await activeSourceSnapshot,
				options,
			);
			const metadata: PostgresSessionMetadata = {
				id,
				createdAt,
				storageVersion: POSTGRES_STORAGE_VERSION,
				parentSessionId: source.id,
			};
			const lease = await this.sql.begin(async (transaction) => {
				await writeForkDestination(transaction, metadata, snapshot);
				return this.acquireLease(transaction, id);
			});
			session = this.openStorageBackedSession(metadata, lease);
			return session;
		} finally {
			if (session === undefined) this.pendingIds.delete(id);
		}
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.stopHeartbeat();
		this.closePromise = this.closeOpenSessions(context);
		return this.closePromise;
	}

	/** Take the lease for `sessionId` or throw {@link SessionLeaseHeldError}. No-op without leases. */
	private async acquireLease(sql: PostgresQueryable, sessionId: string): Promise<OpenSessionLease | undefined> {
		if (!this.leaseEnabled) return undefined;
		const result = await acquireSessionLease(sql, sessionId, this.lease.owner, this.lease.ttlSeconds);
		if (!result.acquired) throw new SessionLeaseHeldError(result.holder);
		return { epoch: result.lease.epoch, owner: this.lease.owner, predecessor: result.predecessor };
	}

	private readForkSourceFromDatabase(
		source: PostgresSessionMetadata,
		options: ForkOptions,
	): Promise<PostgresStorageSnapshot> {
		return this.sql.begin(READ_ONLY_SNAPSHOT, async (transaction) => {
			metadataFromSessionRow(await readSessionRow(transaction, source.id), POSTGRES_STORAGE_VERSION);
			return readForkSource(transaction, source.id, options);
		});
	}

	private async closeOpenSessions(context: Context): Promise<void> {
		const results = await Promise.allSettled([...this.openSessions].map((session) => session.close(context)));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close PostgreSQL Sessions");
	}

	private openStorageBackedSession(
		metadata: PostgresSessionMetadata,
		lease: OpenSessionLease | undefined,
	): PostgresOpenSession {
		const sessionId = metadata.id;
		const storage = new PostgresStorage(this.sql, {
			sessionId,
			now: this.now,
			...(lease === undefined
				? {}
				: {
						fence: {
							epoch: lease.epoch,
							ttlSeconds: this.lease.ttlSeconds,
							onFenced: (error) => this.handleFenced(sessionId, error),
						},
					}),
		});
		this.openStorages.set(sessionId, storage);
		if (lease !== undefined) {
			this.held.set(sessionId, { epoch: lease.epoch, storage });
			this.ensureHeartbeat();
		}
		const session = new StorageBackedSession(metadata, storage);
		const openSession = new PostgresOpenSession(session, {
			lease,
			onClose: async () => {
				if (this.openStorages.get(sessionId) === storage) this.openStorages.delete(sessionId);
				this.openSessions.delete(openSession);
				this.pendingIds.delete(sessionId);
				const heldLease = this.held.get(sessionId);
				if (heldLease?.storage === storage) this.held.delete(sessionId);
				if (this.held.size === 0) this.stopHeartbeat();
				// A fenced session belongs to someone else now; releasing would be a no-op on a stale epoch.
				if (lease !== undefined && storage.fenced === undefined) {
					await releaseSessionLease(this.sql, sessionId, lease.epoch).catch(() => false);
				}
			},
		});
		this.openSessions.add(openSession);
		return openSession;
	}

	private handleFenced(sessionId: string, error: FencedError): void {
		const heldLease = this.held.get(sessionId);
		if (heldLease === undefined) return;
		this.held.delete(sessionId);
		heldLease.storage.markFenced(error);
		if (this.held.size === 0) this.stopHeartbeat();
		this.lease.onFenced?.(sessionId, error);
	}

	private ensureHeartbeat(): void {
		if (this.heartbeatTimer !== undefined || this.lease.heartbeatIntervalMs <= 0 || this.closed) return;
		this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.lease.heartbeatIntervalMs);
		this.heartbeatTimer.unref();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer === undefined) return;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	/**
	 * One statement renews every held lease. Ids missing from the result were taken over: their
	 * storages are fenced now rather than at their next commit, so a stalled worker stops sooner.
	 */
	private async heartbeat(): Promise<void> {
		if (this.heartbeatInFlight || this.held.size === 0) return;
		this.heartbeatInFlight = true;
		const leases = [...this.held.entries()].map(([sessionId, { epoch }]) => ({ sessionId, epoch }));
		try {
			const owned = await heartbeatSessionLeases(this.sql, leases, this.lease.ttlSeconds);
			for (const { sessionId, epoch } of leases) {
				if (owned.has(sessionId)) continue;
				// Skip ids released between the query and now; a fresh lease on the same id has another epoch.
				if (this.held.get(sessionId)?.epoch !== epoch) continue;
				this.handleFenced(
					sessionId,
					new FencedError(sessionId, epoch, `Heartbeat lost the lease for session ${sessionId}`),
				);
			}
		} catch (error) {
			this.lease.onHeartbeatError?.(error);
		} finally {
			this.heartbeatInFlight = false;
		}
	}

	private reserveId(id: string): void {
		if (this.pendingIds.has(id)) throw new Error(`Session is already open: ${id}`);
		this.pendingIds.add(id);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PostgresSessionRepo is closed");
	}
}
