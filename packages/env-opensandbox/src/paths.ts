import { posix } from "node:path";

/** Resolve a caller path against the sandbox working directory. Pure string work; nothing is looked up. */
export function resolveSandboxPath(cwd: string, path: string, homeDirectory: string): string {
	let normalized = path;
	if (normalized === "~") {
		normalized = homeDirectory;
	} else if (normalized.startsWith("~/")) {
		normalized = posix.join(homeDirectory, normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = decodeURIComponent(new URL(normalized).pathname);
		} catch {
			// Keep malformed URLs as ordinary paths so filesystem methods preserve their non-throwing contract.
		}
	}
	return posix.resolve(cwd, normalized);
}

export function sandboxBasename(path: string): string {
	return posix.basename(path);
}

export function sandboxDirname(path: string): string {
	return posix.dirname(path);
}

export function joinSandboxPath(parts: readonly string[]): string {
	return posix.join(...parts);
}
