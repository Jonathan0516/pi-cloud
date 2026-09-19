/**
 * Resource bundles: the skills, prompt templates, and prompt files a tenant's sessions run with.
 *
 * A bundle is immutable and content-addressed: `version = sha256(canonical manifest)`, and the
 * manifest hashes every file. One version therefore names exactly one set of bytes, which is what
 * lets nodes cache versions forever and lets a session be pinned to one with no ambiguity.
 *
 * Layout inside a bundle (all optional):
 *   SYSTEM.md                  replaces the default system prompt
 *   APPEND_SYSTEM.md           appended to the system prompt (also append/*.md)
 *   AGENTS.md                  project instructions, appended like a context file
 *   skills/<name>/SKILL.md     skills (frontmatter: name, description); other files may sit beside
 *   prompts/<name>.md          prompt templates (frontmatter: description, argument-hint)
 *   extensions/                listed but never loaded: tenant code does not run in a worker
 */

import { createHash } from "node:crypto";

export const BUNDLE_FORMAT = 1;
/** Where a bundle is mounted inside every sandbox of a session that uses it. */
export const BUNDLE_MOUNT_PATH = "/opt/pi/bundle";
/** Entry types the built-in worker can render and recover. A bundle without code registers nothing more. */
export const BUILTIN_ENTRY_TYPES = ["message", "compaction", "branch_summary"];
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_BUNDLE_FILES = 2000;

export interface BundleFileEntry {
	path: string;
	sha256: string;
	size: number;
}

export interface BundleManifest {
	format: typeof BUNDLE_FORMAT;
	files: BundleFileEntry[];
	/** Entry types and custom types a worker running this bundle understands (see the upgrade rule). */
	registers: { entryTypes: string[]; customTypes: string[] };
}

export type BundleFiles = ReadonlyMap<string, Uint8Array>;

export class BundleValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BundleValidationError";
	}
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Reject paths that could escape the bundle directory or collide across platforms. */
export function validateBundlePath(path: string): string {
	if (path.length === 0 || path.length > 512)
		throw new BundleValidationError(`Invalid bundle path: ${JSON.stringify(path)}`);
	if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
		throw new BundleValidationError(`Bundle paths must be relative POSIX paths: ${path}`);
	}
	const segments = path.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new BundleValidationError(`Bundle path has an empty, '.', or '..' segment: ${path}`);
	}
	return path;
}

/** Sorted keys at every level, no whitespace: the same manifest always hashes the same. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function buildManifest(files: BundleFiles, registers?: Partial<BundleManifest["registers"]>): BundleManifest {
	if (files.size === 0) throw new BundleValidationError("A bundle needs at least one file");
	if (files.size > MAX_BUNDLE_FILES)
		throw new BundleValidationError(`A bundle may hold at most ${MAX_BUNDLE_FILES} files`);
	let total = 0;
	const entries: BundleFileEntry[] = [];
	for (const [path, bytes] of files) {
		validateBundlePath(path);
		total += bytes.byteLength;
		entries.push({ path, sha256: sha256Hex(bytes), size: bytes.byteLength });
	}
	if (total > MAX_BUNDLE_BYTES) throw new BundleValidationError(`A bundle may hold at most ${MAX_BUNDLE_BYTES} bytes`);
	entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return {
		format: BUNDLE_FORMAT,
		files: entries,
		registers: {
			entryTypes: [...new Set([...BUILTIN_ENTRY_TYPES, ...(registers?.entryTypes ?? [])])].sort(),
			customTypes: [...new Set(registers?.customTypes ?? [])].sort(),
		},
	};
}

export function bundleVersion(manifest: BundleManifest): string {
	return sha256Hex(canonicalJson(manifest));
}

/** Check bytes against a manifest: every listed file present with the right hash, nothing extra. */
export function verifyBundleFiles(manifest: BundleManifest, files: BundleFiles): void {
	const listed = new Map(manifest.files.map((entry) => [entry.path, entry]));
	for (const [path, bytes] of files) {
		const entry = listed.get(path);
		if (entry === undefined) throw new BundleValidationError(`File not in manifest: ${path}`);
		if (entry.size !== bytes.byteLength || entry.sha256 !== sha256Hex(bytes)) {
			throw new BundleValidationError(`File does not match its manifest hash: ${path}`);
		}
		listed.delete(path);
	}
	if (listed.size > 0) throw new BundleValidationError(`Files missing from bundle: ${[...listed.keys()].join(", ")}`);
}

export function isBundleVersion(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}
