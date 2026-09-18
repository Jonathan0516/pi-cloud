import type {
	CommitResult,
	Context,
	Entry,
	EntryScan,
	EntryStructure,
	ForkOptions,
	ListElement,
	ListReadOptions,
	SessionStats,
	Storage,
	StorageBranchScan,
	StoredValue,
	UsageRow,
	UsageScan,
	Value,
	ValueList,
	Write,
} from "@earendil-works/pi-agent-core";
import { branchTip, prepareStorageCommit, validateCommittedWrites } from "@earendil-works/pi-agent-core";
import type { CommittedWrite } from "@earendil-works/pi-agent-core/harness/session";
import { FencedError, fenceSessionLease } from "./lease.ts";
import { appendEntryToBranchIndex, scanBranchEntries, scanBranchEntryStructures } from "./session/branch-entries.ts";
import {
	decodeEntryRow,
	insertEntryRow,
	readAllEntryRows,
	readEntryRows,
	readExistingEntryIds,
	scanEntryRows,
} from "./session/entries.ts";
import { readSessionRow } from "./session/session-row.ts";
import {
	readSessionStats,
	SessionStatsAccumulator,
	sessionStatsFromRow,
	writeSessionStatsAndSeq,
} from "./session/session-stats.ts";
import {
	decodeUsageLedgerRow,
	insertUsageLedgerRow,
	readExistingUsageIds,
	scanUsageLedgerRows,
} from "./session/usage-ledger.ts";
import {
	appendListValueRow,
	deleteListValueRows,
	deleteScalarValueRow,
	readAllScalarValueRows,
	readListValueRows,
	readScalarValueRow,
	scanScalarValueRows,
	setScalarValueRow,
} from "./session/values.ts";
import type { PostgresClient, PostgresQueryable } from "./types.ts";

export interface PostgresStorageFence {
	/** Lease epoch this process holds for the session. */
	epoch: number;
	/** Lease TTL renewed by every commit. */
	ttlSeconds: number;
	/** Called once when a commit finds the lease taken over. Further commits fail fast. */
	onFenced?: (error: FencedError) => void;
}

export interface PostgresStorageOptions {
	sessionId: string;
	now?: () => number;
	/** When set, every commit renews the lease first and refuses to write once the epoch moved on. */
	fence?: PostgresStorageFence;
}

export interface PostgresStorageSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	entriesComplete: boolean;
}

const CLOSED_MESSAGE = "PostgresStorage is closed";
const READ_ONLY_SNAPSHOT = "ISOLATION LEVEL REPEATABLE READ READ ONLY";

function candidateIds(writes: readonly CommittedWrite[]): string[] {
	const ids = new Set<string>();
	for (const write of writes) {
		if (write.kind === "entry") {
			ids.add(write.id);
			if (write.parentId !== null) ids.add(write.parentId);
		} else if (write.kind === "usage") {
			ids.add(write.id);
		}
	}
	return [...ids];
}

/** Reads the source rows a fork needs. Shared by live snapshots and read-only transactions. */
export async function readForkSource(
	sql: PostgresQueryable,
	sessionId: string,
	options: ForkOptions,
): Promise<PostgresStorageSnapshot> {
	const scalarValues = await readAllScalarValueRows(sql, sessionId);
	return {
		entries: await readForkSourceEntries(sql, sessionId, scalarValues, options),
		scalarValues,
		entriesComplete: options.scope === "tree",
	};
}

async function readForkSourceEntries(
	sql: PostgresQueryable,
	sessionId: string,
	scalarValues: readonly StoredValue<unknown>[],
	options: ForkOptions,
): Promise<Entry[]> {
	if (options.scope === "tree") return (await readAllEntryRows(sql, sessionId)).map(decodeEntryRow);
	const sourceAddress = branchTip(options.branch);
	const sourceTip = scalarValues.find(
		(stored) => stored.address.namespace === sourceAddress.namespace && stored.address.key === sourceAddress.key,
	) as StoredValue<string | null> | undefined;
	if (sourceTip === undefined) throw new Error(`Unknown source branch: ${options.branch}`);
	return sourceTip.value === null
		? []
		: scanBranchEntries(sql, sessionId, { start: sourceTip.value, order: "oldestFirst" });
}

/**
 * Storage for one session in a PostgreSQL schema. Commits are serialized in-process and each
 * runs in one transaction; the session row is locked for the commit's duration so the sequence
 * counter and stats projection advance together.
 */
export class PostgresStorage implements Storage {
	private readonly sql: PostgresClient;
	private readonly sessionId: string;
	private readonly now: () => number;
	private readonly fence: PostgresStorageFence | undefined;
	private fencedError: FencedError | undefined;
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(sql: PostgresClient, options: PostgresStorageOptions) {
		this.sql = sql;
		this.sessionId = options.sessionId;
		this.now = options.now ?? Date.now;
		this.fence = options.fence;
	}

	/** The error that fenced this storage, once another process took the session over. */
	get fenced(): FencedError | undefined {
		return this.fencedError;
	}

	/** Record a takeover observed outside a commit (a missed heartbeat). Idempotent. */
	markFenced(error: FencedError): void {
		if (this.fencedError !== undefined) return;
		this.fencedError = error;
		this.fence?.onFenced?.(error);
	}

	commit(writes: Write[], _context: Context): Promise<CommitResult> {
		if (this.state !== "open") return Promise.reject(new Error(CLOSED_MESSAGE));
		if (this.fencedError !== undefined) return Promise.reject(this.fencedError);
		return this.enqueue(() => this.applyCommit(writes));
	}

	async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		this.assertOpen();
		const rowsById = new Map((await readEntryRows(this.sql, this.sessionId, ids)).map((row) => [row.id, row]));
		const entries = new Map<string, Entry>();
		for (const id of ids) {
			const row = rowsById.get(id);
			if (row !== undefined) entries.set(id, decodeEntryRow(row));
		}
		return entries;
	}

	async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		this.assertOpen();
		return readScalarValueRow(this.sql, this.sessionId, address);
	}

	async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		this.assertOpen();
		return scanScalarValueRows(this.sql, this.sessionId, prefix);
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		_context: Context,
	): Promise<ListElement<T>[]> {
		this.assertOpen();
		return readListValueRows(this.sql, this.sessionId, address, options);
	}

	async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		this.assertOpen();
		return scanBranchEntries(this.sql, this.sessionId, query);
	}

	async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
		this.assertOpen();
		return scanBranchEntryStructures(this.sql, this.sessionId, query);
	}

	async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		this.assertOpen();
		return (await scanEntryRows(this.sql, this.sessionId, query)).map(decodeEntryRow);
	}

	async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
		this.assertOpen();
		return (await scanUsageLedgerRows(this.sql, this.sessionId, query)).map(decodeUsageLedgerRow);
	}

	async getStats(_context: Context): Promise<SessionStats> {
		this.assertOpen();
		return readSessionStats(this.sql, this.sessionId);
	}

	/** Coherent fork source captured on this storage's commit boundary. */
	snapshot(options: ForkOptions, _context: Context): Promise<PostgresStorageSnapshot> {
		if (this.state !== "open") return Promise.reject(new Error(CLOSED_MESSAGE));
		return this.enqueue(() =>
			this.sql.begin(READ_ONLY_SNAPSHOT, (transaction) => readForkSource(transaction, this.sessionId, options)),
		);
	}

	close(_context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.commitQueue.then(operation);
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private assertOpen(): void {
		if (this.state !== "open") throw new Error(CLOSED_MESSAGE);
	}

	private async applyCommit(writes: Write[]): Promise<CommitResult> {
		if (this.fencedError !== undefined) throw this.fencedError;
		try {
			return await this.sql.begin(async (transaction) => {
				// The fence comes first so a taken-over process cannot write even one row.
				if (this.fence !== undefined) {
					await fenceSessionLease(transaction, this.sessionId, this.fence.epoch, this.fence.ttlSeconds);
				}
				return this.writeCommit(transaction, writes);
			});
		} catch (error) {
			if (error instanceof FencedError) this.markFenced(error);
			throw error;
		}
	}

	private async writeCommit(transaction: PostgresQueryable, writes: Write[]): Promise<CommitResult> {
		{
			const row = await readSessionRow(transaction, this.sessionId, { forUpdate: true });
			const firstSeq = row.next_seq;
			const prepared = prepareStorageCommit(writes, firstSeq, this.now());

			const ids = candidateIds(prepared.writes);
			const [entryIds, usageIds] = await Promise.all([
				readExistingEntryIds(transaction, this.sessionId, ids),
				readExistingUsageIds(transaction, this.sessionId, ids),
			]);
			validateCommittedWrites(prepared.writes, firstSeq, {
				hasEntryOrUsageId: (id) => entryIds.has(id) || usageIds.has(id),
				hasEntryId: (id) => entryIds.has(id),
			});

			const stats = new SessionStatsAccumulator(sessionStatsFromRow(row));
			for (const write of prepared.writes) {
				switch (write.kind) {
					case "entry": {
						const { kind: _kind, ...entry } = write;
						await insertEntryRow(transaction, this.sessionId, entry);
						await appendEntryToBranchIndex(transaction, this.sessionId, entry);
						if (entry.type === "message") stats.countMessage();
						break;
					}
					case "usage": {
						const { kind: _kind, ...usageRow } = write;
						await insertUsageLedgerRow(transaction, this.sessionId, usageRow);
						stats.addUsage(usageRow.usage);
						break;
					}
					case "value":
						if (write.op === "delete") {
							await deleteScalarValueRow(transaction, this.sessionId, write.namespace, write.key);
						} else {
							await setScalarValueRow(
								transaction,
								this.sessionId,
								write.namespace,
								write.key,
								write.seq,
								write.value,
							);
						}
						break;
					case "list":
						if (write.op === "delete") {
							await deleteListValueRows(transaction, this.sessionId, write.namespace, write.key);
						} else {
							await appendListValueRow(
								transaction,
								this.sessionId,
								write.namespace,
								write.key,
								write.seq,
								write.value,
							);
						}
						break;
				}
			}
			await writeSessionStatsAndSeq(transaction, this.sessionId, stats.stats, firstSeq + prepared.writes.length);
			return { ...prepared.result, stats: stats.stats };
		}
	}
}
