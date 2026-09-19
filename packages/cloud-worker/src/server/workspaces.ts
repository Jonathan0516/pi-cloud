/**
 * Workspace reclamation.
 *
 * A session's `/workspace` is a host directory that outlives its sandbox on purpose: the sandbox
 * is disposable, the work in it is not. Nothing else ever deletes those directories, so without
 * this sweep a node's disk fills with the checkouts of sessions that ended weeks ago.
 *
 * The policy is deliberately timid. A directory goes only when no worker holds the session and
 * either its session row is gone (deleted through the gateway) or it has been idle past the
 * retention window. The decision is a pure function so the dangerous part is tested without a
 * filesystem.
 */

import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PostgresClient } from "@earendil-works/pi-session-backend-postgres";

/** A directory under the workspaces root, with what the database says about its session. */
export interface WorkspaceCandidate {
	sessionId: string;
	/** Directory mtime in ms. Only used to let a brand-new directory escape the orphan rule. */
	modifiedAt: number;
	/** A session row with this id exists. */
	exists: boolean;
	/** A live lease holds the session right now, so a worker is using this directory. */
	leased: boolean;
	/** Newest entry timestamp, or the session's creation time when it has no entries. */
	lastActivityAt: number | undefined;
}

export interface WorkspacePolicy {
	now: number;
	/** Remove a workspace idle for longer than this. 0 disables age-based removal. */
	retentionMs: number;
	/** How old a directory with no session row must be before it counts as an orphan. */
	orphanGraceMs: number;
}

export interface WorkspaceVerdict {
	sessionId: string;
	action: "keep" | "remove";
	reason: string;
}

export function planWorkspaceCleanup(
	candidates: readonly WorkspaceCandidate[],
	policy: WorkspacePolicy,
): WorkspaceVerdict[] {
	return candidates.map((candidate): WorkspaceVerdict => {
		const { sessionId } = candidate;
		if (candidate.leased) return { sessionId, action: "keep", reason: "a worker holds the session" };
		if (!candidate.exists) {
			const age = policy.now - candidate.modifiedAt;
			// A worker creates the directory around the time its session row appears; never race that.
			return age < policy.orphanGraceMs
				? { sessionId, action: "keep", reason: "no session row yet, but the directory is new" }
				: { sessionId, action: "remove", reason: "the session no longer exists" };
		}
		if (policy.retentionMs === 0) return { sessionId, action: "keep", reason: "retention is disabled" };
		const lastActivityAt = candidate.lastActivityAt ?? candidate.modifiedAt;
		const idleMs = policy.now - lastActivityAt;
		return idleMs > policy.retentionMs
			? { sessionId, action: "remove", reason: `idle for ${Math.floor(idleMs / 86_400_000)} days` }
			: { sessionId, action: "keep", reason: "active within the retention window" };
	});
}

/** Directory names that could be a session id. Anything else, including dotfiles, is left alone. */
const SESSION_DIRECTORY = /^[A-Za-z0-9_-]{8,128}$/;

interface SessionFacts {
	exists: boolean;
	leased: boolean;
	lastActivityAt: number | undefined;
}

/** One round trip for every candidate: existence, live lease, and last activity. */
export async function readWorkspaceFacts(
	sql: PostgresClient,
	sessionIds: readonly string[],
): Promise<Map<string, SessionFacts>> {
	if (sessionIds.length === 0) return new Map();
	const rows = await sql<{ id: string; last_activity: number | null; leased: boolean | null }[]>`
		SELECT s.id,
			GREATEST(s.created_at, COALESCE(MAX(e.timestamp), 0)) AS last_activity,
			BOOL_OR(l.state = 'held' AND l.expires_at > now()) AS leased
		FROM sessions s
		LEFT JOIN entries e ON e.session_id = s.id
		LEFT JOIN session_leases l ON l.session_id = s.id
		WHERE s.id = ANY(${[...sessionIds]}::text[])
		GROUP BY s.id`;
	const facts = new Map<string, SessionFacts>();
	for (const row of rows) {
		facts.set(row.id, {
			exists: true,
			leased: row.leased === true,
			lastActivityAt: row.last_activity ?? undefined,
		});
	}
	return facts;
}

export interface WorkspaceSweepOptions {
	workspacesRoot: string;
	retentionMs: number;
	orphanGraceMs?: number;
	now?: number;
	log?: (message: string) => void;
}

const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Apply the policy to the workspaces root. Returns the session ids whose directories were removed. */
export async function sweepWorkspaces(sql: PostgresClient, options: WorkspaceSweepOptions): Promise<string[]> {
	const log = options.log ?? ((message: string) => console.error(message));
	let entries: Dirent[];
	try {
		entries = await readdir(options.workspacesRoot, { withFileTypes: true });
	} catch {
		return []; // The root appears when the first session does.
	}
	const candidates: WorkspaceCandidate[] = [];
	for (const entry of entries) {
		// `.bundles` lives here by default; dot-directories are never workspaces.
		if (!entry.isDirectory() || entry.name.startsWith(".") || !SESSION_DIRECTORY.test(entry.name)) continue;
		let modifiedAt: number;
		try {
			modifiedAt = (await stat(join(options.workspacesRoot, entry.name))).mtimeMs;
		} catch {
			continue;
		}
		candidates.push({ sessionId: entry.name, modifiedAt, exists: false, leased: false, lastActivityAt: undefined });
	}
	if (candidates.length === 0) return [];

	const facts = await readWorkspaceFacts(
		sql,
		candidates.map((candidate) => candidate.sessionId),
	);
	const verdicts = planWorkspaceCleanup(
		candidates.map((candidate) => ({ ...candidate, ...(facts.get(candidate.sessionId) ?? {}) })),
		{
			now: options.now ?? Date.now(),
			retentionMs: options.retentionMs,
			orphanGraceMs: options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
		},
	);

	const removed: string[] = [];
	for (const verdict of verdicts) {
		if (verdict.action !== "remove") continue;
		try {
			await rm(join(options.workspacesRoot, verdict.sessionId), { recursive: true, force: true });
			removed.push(verdict.sessionId);
			log(`reclaimed the workspace of session ${verdict.sessionId}: ${verdict.reason}`);
		} catch (error) {
			log(`could not reclaim the workspace of session ${verdict.sessionId}: ${String(error)}`);
		}
	}
	return removed;
}
