import type { Entry, EntryStructure, StorageBranchScan } from "@earendil-works/pi-agent-core";
import type { PostgresQueryable } from "../types.ts";
import { decodeEntryRow, type EntryRow, entryStructureFromRow } from "./entries.ts";

interface BranchMembershipRow {
	branch_id: string;
	entry_seq: number;
}

interface BranchMetaRow {
	branch_id: string;
	tip_entry_id: string;
	tip_seq: number;
	base_branch_id: string | null;
	base_seq: number | null;
}

interface BranchSegment {
	branchId: string;
	lowerSeq: number;
	upperSeq: number;
}

interface StopSeqRow {
	stop_seq: number | null;
}

interface BranchTipRow {
	branch_id: string;
}

interface CompactionBoundary {
	branchId: string;
	seq: number;
}

interface CompactionBoundaryRow {
	entry_seq: number | null;
}

type EntryStructureRow = Omit<EntryRow, "payload">;

async function readBranchMembership(
	sql: PostgresQueryable,
	sessionId: string,
	entryId: string,
): Promise<BranchMembershipRow> {
	const [row] = await sql<BranchMembershipRow[]>`SELECT b.branch_id, b.entry_seq
		FROM branch_entries b
		JOIN branch_meta m ON m.session_id = b.session_id AND m.branch_id = b.branch_id
		WHERE b.session_id = ${sessionId}
			AND b.entry_id = ${entryId}
			AND ((m.base_seq IS NULL AND b.entry_seq > 0) OR (m.base_seq IS NOT NULL AND b.entry_seq > m.base_seq))
			AND b.entry_seq <= m.tip_seq
		ORDER BY m.tip_seq DESC, b.branch_id
		LIMIT 1`;
	if (row === undefined) throw new Error(`Branch cache missing entry ${entryId}`);
	return row;
}

async function readBranchMeta(sql: PostgresQueryable, sessionId: string, branchId: string): Promise<BranchMetaRow> {
	const [row] = await sql<BranchMetaRow[]>`SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq
		FROM branch_meta
		WHERE session_id = ${sessionId} AND branch_id = ${branchId}`;
	if (row === undefined) throw new Error(`Branch metadata missing for branch ${branchId}`);
	return row;
}

async function insertBranchEntry(
	sql: PostgresQueryable,
	sessionId: string,
	branchId: string,
	entry: Entry,
): Promise<void> {
	await sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
		VALUES (${sessionId}, ${branchId}, ${entry.id}, ${entry.seq}, ${entry.type})`;
}

async function readBranchTipForParent(
	sql: PostgresQueryable,
	sessionId: string,
	parentId: string,
): Promise<BranchTipRow | undefined> {
	const [row] = await sql<BranchTipRow[]>`SELECT branch_id
		FROM branch_meta
		WHERE session_id = ${sessionId} AND tip_entry_id = ${parentId}`;
	return row;
}

async function createRootBranchForEntry(sql: PostgresQueryable, sessionId: string, entry: Entry): Promise<void> {
	await sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
		VALUES (${sessionId}, ${entry.id}, ${entry.id}, ${entry.seq}, ${null}, ${null})`;
	await insertBranchEntry(sql, sessionId, entry.id, entry);
}

async function appendEntryToExistingBranch(
	sql: PostgresQueryable,
	sessionId: string,
	branchId: string,
	entry: Entry,
): Promise<void> {
	await insertBranchEntry(sql, sessionId, branchId, entry);
	const result = await sql`UPDATE branch_meta
		SET tip_entry_id = ${entry.id}, tip_seq = ${entry.seq}
		WHERE session_id = ${sessionId} AND branch_id = ${branchId}`;
	if (result.count !== 1) throw new Error(`Expected to update branch ${branchId}, updated ${result.count}`);
}

async function readBranchSegmentsNewestFirst(
	sql: PostgresQueryable,
	sessionId: string,
	start: string,
): Promise<BranchSegment[]> {
	let { branch_id: branchId, entry_seq: upperSeq } = await readBranchMembership(sql, sessionId, start);
	const segments: BranchSegment[] = [];
	while (true) {
		const meta = await readBranchMeta(sql, sessionId, branchId);
		const lowerSeq = meta.base_seq ?? 0;
		segments.push({ branchId, lowerSeq, upperSeq });
		if (meta.base_branch_id === null) break;
		if (meta.base_seq === null) throw new Error(`Branch ${branchId} has base branch without base_seq`);
		branchId = meta.base_branch_id;
		upperSeq = meta.base_seq;
	}
	return segments;
}

async function readNewestCompactionBoundary(
	sql: PostgresQueryable,
	sessionId: string,
	segmentsNewestFirst: readonly BranchSegment[],
): Promise<CompactionBoundary | undefined> {
	for (const segment of segmentsNewestFirst) {
		const [row] = await sql<CompactionBoundaryRow[]>`SELECT MAX(entry_seq) AS entry_seq
			FROM branch_entries
			WHERE session_id = ${sessionId}
				AND branch_id = ${segment.branchId}
				AND entry_seq > ${segment.lowerSeq}
				AND entry_seq <= ${segment.upperSeq}
				AND entry_type = ${"compaction"}`;
		if (row?.entry_seq !== null && row?.entry_seq !== undefined) {
			return { branchId: segment.branchId, seq: row.entry_seq };
		}
	}
	return undefined;
}

async function copyBranchEntriesAfterSeqThroughParent(
	sql: PostgresQueryable,
	sessionId: string,
	targetBranchId: string,
	segmentsNewestFirst: readonly BranchSegment[],
	afterSeq: number,
): Promise<void> {
	for (const segment of [...segmentsNewestFirst].reverse()) {
		const lowerSeq = Math.max(segment.lowerSeq, afterSeq);
		if (segment.upperSeq <= lowerSeq) continue;
		await sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
			SELECT ${sessionId}, ${targetBranchId}, entry_id, entry_seq, entry_type
			FROM branch_entries
			WHERE session_id = ${sessionId}
				AND branch_id = ${segment.branchId}
				AND entry_seq > ${lowerSeq}
				AND entry_seq <= ${segment.upperSeq}`;
	}
}

async function createDivergentBranchForEntry(sql: PostgresQueryable, sessionId: string, entry: Entry): Promise<void> {
	if (entry.parentId === null) throw new Error("Root entries do not create divergent branches");
	const segmentsNewestFirst = await readBranchSegmentsNewestFirst(sql, sessionId, entry.parentId);
	const compaction = await readNewestCompactionBoundary(sql, sessionId, segmentsNewestFirst);
	const branchId = entry.id;
	// A null base means this segment stores its own root-through-parent prefix.
	await sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
		VALUES (${sessionId}, ${branchId}, ${entry.id}, ${entry.seq}, ${compaction?.branchId ?? null}, ${compaction?.seq ?? null})`;
	await copyBranchEntriesAfterSeqThroughParent(sql, sessionId, branchId, segmentsNewestFirst, compaction?.seq ?? 0);
	await insertBranchEntry(sql, sessionId, branchId, entry);
}

export async function appendEntryToBranchIndex(sql: PostgresQueryable, sessionId: string, entry: Entry): Promise<void> {
	if (entry.parentId === null) {
		await createRootBranchForEntry(sql, sessionId, entry);
		return;
	}

	const branch = await readBranchTipForParent(sql, sessionId, entry.parentId);
	if (branch === undefined) {
		await createDivergentBranchForEntry(sql, sessionId, entry);
		return;
	}
	await appendEntryToExistingBranch(sql, sessionId, branch.branch_id, entry);
}

async function readStopSeq(
	sql: PostgresQueryable,
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
): Promise<number | undefined> {
	if (query.stopAtType === undefined && query.stopAtId === undefined) return undefined;
	const [row] = await sql<
		StopSeqRow[]
	>`SELECT ${oldestFirst ? sql`MIN(b.entry_seq)` : sql`MAX(b.entry_seq)`} AS stop_seq
		FROM branch_entries b
		WHERE b.session_id = ${sessionId}
			AND b.branch_id = ${segment.branchId}
			AND b.entry_seq > ${segment.lowerSeq}
			AND b.entry_seq <= ${segment.upperSeq}
			AND (
				${query.stopAtType === undefined ? sql`FALSE` : sql`b.entry_type = ${query.stopAtType}`}
				OR ${query.stopAtId === undefined ? sql`FALSE` : sql`b.entry_id = ${query.stopAtId}`}
			)`;
	return row?.stop_seq ?? undefined;
}

type SegmentReader<T> = (
	sql: PostgresQueryable,
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
	limit: number | undefined,
) => Promise<T[]>;

function segmentScan<TRow extends object>(
	sql: PostgresQueryable,
	columns: ReturnType<PostgresQueryable>,
	sessionId: string,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
	limit: number | undefined,
) {
	return sql<TRow[]>`SELECT ${columns}
		FROM branch_entries b
		JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id
		WHERE b.session_id = ${sessionId}
			AND b.branch_id = ${segment.branchId}
			AND b.entry_seq > ${segment.lowerSeq}
			AND b.entry_seq <= ${segment.upperSeq}
			${
				stopSeq === undefined
					? sql``
					: oldestFirst
						? sql`AND b.entry_seq <= ${stopSeq}`
						: sql`AND b.entry_seq >= ${stopSeq}`
			}
			${query.type === undefined ? sql`` : sql`AND b.entry_type = ${query.type}`}
			${query.customType === undefined ? sql`` : sql`AND e.custom_type = ${query.customType}`}
			${
				query.cursor === undefined
					? sql``
					: oldestFirst
						? sql`AND b.entry_seq > ${query.cursor.seq}`
						: sql`AND b.entry_seq < ${query.cursor.seq}`
			}
		${oldestFirst ? sql`ORDER BY b.entry_seq ASC` : sql`ORDER BY b.entry_seq DESC`}
		${limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, limit)}`}`;
}

const scanEntrySegmentRows: SegmentReader<EntryRow> = (sql, ...rest) =>
	segmentScan<EntryRow>(sql, sql`e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp, e.payload`, ...rest);

const scanStructureSegmentRows: SegmentReader<EntryStructureRow> = (sql, ...rest) =>
	segmentScan<EntryStructureRow>(sql, sql`e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp`, ...rest);

async function scanBranchSegments<T>(
	sql: PostgresQueryable,
	sessionId: string,
	query: StorageBranchScan,
	readSegment: SegmentReader<T>,
): Promise<T[]> {
	const oldestFirst = query.order === "oldestFirst";
	const segmentsNewestFirst = await readBranchSegmentsNewestFirst(sql, sessionId, query.start);
	const segments = oldestFirst ? [...segmentsNewestFirst].reverse() : segmentsNewestFirst;
	const limit = query.limit === undefined ? undefined : Math.max(0, query.limit);
	if (limit === 0) return [];

	const rows: T[] = [];
	for (const segment of segments) {
		const remaining = limit === undefined ? undefined : limit - rows.length;
		if (remaining !== undefined && remaining <= 0) break;
		const stopSeq = await readStopSeq(sql, sessionId, segment, query, oldestFirst);
		rows.push(...(await readSegment(sql, sessionId, segment, query, oldestFirst, stopSeq, remaining)));
		if (stopSeq !== undefined) break;
	}
	return rows;
}

export async function scanBranchEntries(
	sql: PostgresQueryable,
	sessionId: string,
	query: StorageBranchScan,
): Promise<Entry[]> {
	return (await scanBranchSegments(sql, sessionId, query, scanEntrySegmentRows)).map(decodeEntryRow);
}

export async function scanBranchEntryStructures(
	sql: PostgresQueryable,
	sessionId: string,
	query: StorageBranchScan,
): Promise<EntryStructure[]> {
	return (await scanBranchSegments(sql, sessionId, query, scanStructureSegmentRows)).map(entryStructureFromRow);
}
