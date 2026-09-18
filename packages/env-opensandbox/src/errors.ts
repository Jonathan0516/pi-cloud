import { SandboxApiException } from "@alibaba-group/opensandbox";
import { ExecutionError, FileError, toError } from "@earendil-works/pi-agent-core";

/** Best available message for an API failure: structured error, raw body, then the exception text. */
export function apiMessage(error: SandboxApiException): string {
	if (error.error?.message) return error.error.message;
	const body = error.rawBody;
	if (typeof body === "string" && body.length > 0) return body;
	if (body !== null && typeof body === "object" && "message" in body && typeof body.message === "string") {
		return body.message;
	}
	return error.message;
}

/** Map a failed SDK call to the backend-independent {@link FileError} contract. */
export function toFileError(error: unknown, path: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	if (error instanceof SandboxApiException) {
		const message = apiMessage(error);
		const lower = message.toLowerCase();
		if (lower.includes("not a directory")) return new FileError("not_directory", message, path, cause);
		if (lower.includes("is a directory")) return new FileError("is_directory", message, path, cause);
		if (error.statusCode === 404 || lower.includes("no such file or directory") || lower.includes("not found")) {
			return new FileError("not_found", message, path, cause);
		}
		if (error.statusCode === 403 || lower.includes("permission denied")) {
			return new FileError("permission_denied", message, path, cause);
		}
		if (error.statusCode === 400) return new FileError("invalid", message, path, cause);
		return new FileError("unknown", message, path, cause);
	}
	if (cause.name === "AbortError") return new FileError("aborted", "aborted", path, cause);
	return new FileError("unknown", cause.message, path, cause);
}

/**
 * Whether a failure means the sandbox itself is unreachable or gone, so the provider should
 * re-provision before the next operation.
 */
export function isSandboxUnavailable(error: unknown): boolean {
	if (error instanceof SandboxApiException) {
		const lower = apiMessage(error).toLowerCase();
		return lower.includes("sandbox") && (lower.includes("not found") || lower.includes("not running"));
	}
	const cause = toError(error);
	if (cause.name === "AbortError") return false;
	const code = "code" in cause && typeof cause.code === "string" ? cause.code : "";
	return (
		/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network/i.test(
			`${code} ${cause.message}`,
		) || cause.name === "TypeError"
	);
}

export function toSpawnError(error: unknown, fallback: string): ExecutionError {
	const cause = toError(error);
	const message = error instanceof SandboxApiException ? apiMessage(error) : cause.message;
	return new ExecutionError("spawn_error", `${fallback}: ${message}`, cause);
}
