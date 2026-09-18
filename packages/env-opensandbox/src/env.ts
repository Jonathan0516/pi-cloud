import { randomUUID } from "node:crypto";
import { Sandbox } from "@alibaba-group/opensandbox";
import {
	type Context,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	OutputCapture,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
	toError,
} from "@earendil-works/pi-agent-core";
import { isSandboxUnavailable, toFileError, toSpawnError } from "./errors.ts";
import { joinSandboxPath, resolveSandboxPath, sandboxBasename, sandboxDirname } from "./paths.ts";
import { type SandboxProvider, StaticSandboxProvider } from "./provisioner.ts";
import { buildShellInvocation, decodeTransportedLine, exitCodeFromExecution, shellQuote } from "./shell.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const DEFAULT_MAX_SPILL_BYTES = 32 * 1024 * 1024;
const DEFAULT_INTERRUPT_GRACE_MS = 10_000;
const DIRECTORY_MODE = 755;

export interface OpenSandboxExecutionEnvOptions {
	/** Sandbox supplier, or a sandbox the caller owns. */
	provider: SandboxProvider | Sandbox;
	/** Absolute working directory inside the sandbox. */
	cwd: string;
	/** Expansion target for `~`. Defaults to `/root`. */
	homeDirectory?: string;
	/** Shell that runs every command. Defaults to `/bin/bash`. */
	shellPath?: string;
	/** Variables applied to every command before per-call overrides. */
	shellEnv?: Record<string, string>;
	/** Directory for temporary files and spilled output. Defaults to `/tmp`. */
	tempDirectory?: string;
	/** Largest complete output preserved for a spill before the command is failed. Defaults to 32 MiB. */
	maxSpillBytes?: number;
	/** How long to wait for an interrupted command to report back before settling without it. */
	interruptGraceMs?: number;
	/** Close the provider from `cleanup()`. Defaults to true for a provider and false for a bare sandbox. */
	ownsProvider?: boolean;
}

interface SandboxFileInfo {
	path: string;
	type?: "file" | "directory" | "symlink" | "other";
	size?: number;
	modifiedAt?: Date | string;
}

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

function fileKindFromType(type: SandboxFileInfo["type"]): FileKind | undefined {
	switch (type) {
		case "file":
		case "directory":
		case "symlink":
			return type;
		default:
			return undefined;
	}
}

function mtimeMsFrom(value: Date | string | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? 0 : parsed;
	}
	return 0;
}

function fileInfoFromSandbox(path: string, info: SandboxFileInfo): Result<FileInfo, FileError> {
	const kind = fileKindFromType(info.type);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({ name: sandboxBasename(path), path, kind, size: info.size ?? 0, mtimeMs: mtimeMsFrom(info.modifiedAt) });
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const merged = new Uint8Array(left.length + right.length);
	merged.set(left, 0);
	merged.set(right, left.length);
	return merged;
}

function encodeContent(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** Strict LF reader over content fetched once; the sandbox API has no incremental file handle. */
class BufferedTextLineReader implements TextLineReader {
	private readonly path: string;
	private buffered: string;
	private closed = false;

	constructor(content: string, path: string) {
		this.buffered = content;
		this.path = path;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const aborted = abortResult<TextLine | undefined>(context.abortSignal, this.path);
		if (aborted) return aborted;
		if (this.closed) return err(new FileError("invalid", "Text line reader is closed", this.path));
		const newline = this.buffered.indexOf("\n");
		if (newline !== -1) {
			const text = this.buffered.slice(0, newline);
			this.buffered = this.buffered.slice(newline + 1);
			return ok({ text, terminated: true });
		}
		if (this.buffered.length === 0) return ok(undefined);
		const text = this.buffered;
		this.buffered = "";
		return ok({ text, terminated: false });
	}

	async close(_context: Context): Promise<void> {
		this.closed = true;
		this.buffered = "";
	}
}

/**
 * {@link ExecutionEnv} backed by an OpenSandbox sandbox. File operations use the execd file API;
 * commands run through an execd session so they can be interrupted on abort or timeout.
 */
export class OpenSandboxExecutionEnv implements ExecutionEnv {
	cwd: string;
	private readonly provider: SandboxProvider;
	private readonly ownsProvider: boolean;
	private readonly homeDirectory: string;
	private readonly shellPath: string;
	private readonly shellEnv: Record<string, string>;
	private readonly tempDirectory: string;
	private readonly maxSpillBytes: number;
	private readonly interruptGraceMs: number;
	private readonly activeSessions = new Map<string, Sandbox>();
	private readonly shellChecked = new WeakSet<Sandbox>();

	constructor(options: OpenSandboxExecutionEnvOptions) {
		const bareSandbox = options.provider instanceof Sandbox;
		this.provider = bareSandbox
			? new StaticSandboxProvider(options.provider as Sandbox)
			: (options.provider as SandboxProvider);
		this.ownsProvider = options.ownsProvider ?? !bareSandbox;
		this.cwd = options.cwd;
		this.homeDirectory = options.homeDirectory ?? "/root";
		this.shellPath = options.shellPath ?? "/bin/bash";
		this.shellEnv = { ...options.shellEnv };
		this.tempDirectory = options.tempDirectory ?? "/tmp";
		this.maxSpillBytes = options.maxSpillBytes ?? DEFAULT_MAX_SPILL_BYTES;
		this.interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(joinSandboxPath(parts));
	}

	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const signal = context.abortSignal;
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;
		const cwd = options?.cwd ? this.resolve(options.cwd) : this.cwd;
		const invocation = buildShellInvocation(
			this.shellPath,
			command,
			options?.inheritEnv === false ? options.env : { ...this.shellEnv, ...options?.env },
			options?.inheritEnv ?? true,
		);
		if ("error" in invocation) return err(new ExecutionError("spawn_error", invocation.error));

		const acquired = await this.provider.acquire(context);
		if (!acquired.ok) return err(acquired.error);
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const sandbox = acquired.value;
		const shell = await this.ensureShell(sandbox, context);
		if (!shell.ok) return shell;
		// execd creates sessions for missing directories and only fails later; check up front like the Node environment.
		const cwdInfo = await this.fileInfo(cwd, context);
		if (!cwdInfo.ok) {
			if (cwdInfo.error.code === "aborted") return err(new ExecutionError("aborted", "aborted"));
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cwdInfo.error,
				),
			);
		}
		if (cwdInfo.value.kind !== "directory") {
			return err(new ExecutionError("spawn_error", `Working directory is not a directory: ${cwd}`));
		}
		if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));

		let sessionId: string;
		try {
			sessionId = await sandbox.commands.createSession({ workingDirectory: cwd });
		} catch (error) {
			return err(this.spawnError(sandbox, error, cwd));
		}
		this.activeSessions.set(sessionId, sandbox);

		return await new Promise((resolvePromise) => {
			let settled = false;
			let timedOut = false;
			let interrupted = false;
			let callbackError: ExecutionError | undefined;
			let spillError: ExecutionError | undefined;
			let spillPath: string | undefined;
			let spillStart: Promise<void> | undefined;
			let spillBytes = 0;
			const spillChunks: string[] = [];
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			let graceId: ReturnType<typeof setTimeout> | undefined;

			const interrupt = () => {
				if (interrupted) return;
				interrupted = true;
				void sandbox.commands.interrupt(sessionId).catch(() => undefined);
				graceId = setTimeout(() => finalize(undefined), this.interruptGraceMs);
			};
			const failCallback = (error: unknown) => {
				if (callbackError !== undefined) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				interrupt();
			};
			const failSpill = (error: unknown) => {
				if (spillError !== undefined) return;
				const cause = toError(error);
				spillError = new ExecutionError(
					"unknown",
					`Failed to preserve complete shell output: ${cause.message}`,
					cause,
				);
				interrupt();
			};
			let capture: OutputCapture;
			try {
				capture = new OutputCapture(options?.capture, context, {
					onUpdate: options?.onUpdate,
					onError: failCallback,
				});
			} catch (error) {
				const cause = toError(error);
				this.activeSessions.delete(sessionId);
				void sandbox.commands.deleteSession(sessionId).catch(() => undefined);
				resolvePromise(err(new ExecutionError("unknown", cause.message, cause)));
				return;
			}

			const settle = (result: Result<ShellExecResult, ExecutionError>) => {
				if (settled) return;
				settled = true;
				if (timeoutId) clearTimeout(timeoutId);
				if (graceId) clearTimeout(graceId);
				if (signal) signal.removeEventListener("abort", onAbort);
				this.activeSessions.delete(sessionId);
				capture.dispose();
				void sandbox.commands.deleteSession(sessionId).catch(() => undefined);
				resolvePromise(result);
			};
			const onAbort = () => interrupt();

			const startSpill = () => {
				if (spillStart !== undefined) return;
				spillStart = this.createTempFile({ prefix: "pi-output-", suffix: ".log" }, context)
					.then((created) => {
						if (!created.ok) throw created.error;
						spillPath = created.value;
						capture.setSpillPath(spillPath);
					})
					.catch(failSpill);
			};
			const feed = (text: string) => {
				try {
					capture.push(text);
					if (!options?.capture?.spill || text.length === 0) return;
					spillChunks.push(text);
					spillBytes += text.length;
					if (spillBytes > this.maxSpillBytes) {
						failSpill(new Error(`output exceeds ${this.maxSpillBytes} bytes`));
						return;
					}
					if (capture.truncated) startSpill();
				} catch (error) {
					failCallback(error);
				}
			};

			const writeSpill = async (): Promise<void> => {
				await spillStart;
				if (spillPath === undefined || spillError !== undefined) return;
				try {
					await sandbox.files.writeFiles([{ path: spillPath, data: spillChunks.join("") }]);
				} catch (error) {
					failSpill(error);
				}
			};

			const finalize = async (execution: Awaited<ReturnType<Sandbox["commands"]["runInSession"]>> | undefined) => {
				if (settled) return;
				await writeSpill();
				try {
					capture.finish();
					capture.flush();
				} catch (error) {
					failCallback(error);
				}
				if (callbackError) return settle(err(callbackError));
				if (timedOut) return settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
				if (signal?.aborted) return settle(err(new ExecutionError("aborted", "aborted")));
				if (spillError) return settle(err(spillError));
				if (execution === undefined) {
					return settle(err(new ExecutionError("unknown", "Command did not report completion after interrupt")));
				}
				const output = capture.snapshot();
				const exitCode =
					execution.exitCode === null && timeoutMs !== undefined
						? 124
						: exitCodeFromExecution(execution.exitCode, execution.error?.traceback);
				settle(
					ok({
						exitCode,
						truncation: output.truncation,
						...(output.spillPath === undefined ? {} : { spillPath: output.spillPath }),
						...(output.lastLineBytes === undefined ? {} : { lastLineBytes: output.lastLineBytes }),
					}),
				);
			};

			if (timeoutMs !== undefined) {
				timeoutId = setTimeout(() => {
					timedOut = true;
					interrupt();
				}, timeoutMs);
			}
			if (signal) {
				if (signal.aborted) interrupt();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			sandbox.commands
				.runInSession(
					sessionId,
					invocation.commandLine,
					// Server-side backstop in whole seconds; the local timer is authoritative.
					timeoutMs === undefined ? {} : { timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000) + 1) },
					{
						// stderr is merged into stdout by the wrapper; anything else on stderr is execd's own.
						onStdout: (message) => feed(decodeTransportedLine(message.text)),
						onStderr: (message) => feed(`${message.text}\n`),
						skipAccumulation: true,
					},
				)
				.then(
					(execution) => void finalize(execution),
					(error: unknown) => {
						if (interrupted) {
							void finalize(undefined);
							return;
						}
						settle(err(this.spawnError(sandbox, error, cwd)));
					},
				);
		});
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		if (!bytes.ok) return bytes;
		return ok(new TextDecoder().decode(bytes.value));
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = this.resolve(path);
		const content = await this.readTextFile(resolved, context);
		if (!content.ok) return content;
		return ok(new BufferedTextLineReader(content.value, resolved));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<Uint8Array>(context.abortSignal, resolved);
		if (aborted) return aborted;
		return this.withSandbox(resolved, context, async (sandbox) => {
			try {
				return ok(await sandbox.files.readBytes(resolved));
			} catch (error) {
				const mapped = toFileError(error, resolved);
				if (mapped.code !== "unknown") return err(mapped);
				// The download endpoint reports directories as a generic failure; classify by metadata.
				const info = await this.fileInfo(resolved, context);
				if (info.ok && info.value.kind === "directory") {
					return err(new FileError("is_directory", mapped.message, resolved, mapped));
				}
				return err(mapped);
			}
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		return this.withSandbox(resolved, context, async (sandbox) => {
			await sandbox.files.writeFiles([{ path: resolved, data: content }]);
			return ok(undefined);
		});
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const existing = await this.readBinaryFile(resolved, context);
		let current: Uint8Array;
		if (existing.ok) current = existing.value;
		else if (existing.error.code === "not_found") current = new Uint8Array(0);
		else return err(existing.error);
		const afterReadAbort = abortResult<void>(context.abortSignal, resolved);
		if (afterReadAbort) return afterReadAbort;
		return this.writeFile(resolved, concatBytes(current, encodeContent(content)), context);
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		const aborted = abortResult<void>(context.abortSignal, destination);
		if (aborted) return aborted;
		const moved = await this.runUtility(`mv -f -- ${shellQuote(source)} ${shellQuote(destination)}`, source, context);
		if (!moved.ok) return moved;
		if (moved.value.exitCode === 0) return ok(undefined);
		return err(utilityFailure(moved.value.stderr, source));
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<FileInfo>(context.abortSignal, resolved);
		if (aborted) return aborted;
		return this.withSandbox(resolved, context, async (sandbox) => {
			const infos = (await sandbox.files.getFileInfo([resolved])) as Record<string, SandboxFileInfo>;
			const info = infos[resolved] ?? Object.values(infos)[0];
			if (info === undefined)
				return err(new FileError("not_found", `No metadata returned for ${resolved}`, resolved));
			return fileInfoFromSandbox(resolved, info);
		});
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<FileInfo[]>(context.abortSignal, resolved);
		if (aborted) return aborted;
		return this.withSandbox(resolved, context, async (sandbox) => {
			const entries = (await sandbox.files.listDirectory({ path: resolved, depth: 1 })) as SandboxFileInfo[];
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const info = fileInfoFromSandbox(entry.path, entry);
				if (info.ok) infos.push(info.value);
			}
			return ok(infos);
		});
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<string>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const ran = await this.runUtility(`realpath -e -- ${shellQuote(resolved)}`, resolved, context);
		if (!ran.ok) return ran;
		if (ran.value.exitCode !== 0) return err(utilityFailure(ran.value.stderr, resolved));
		return ok(ran.value.stdout.replace(/\n$/, ""));
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path, context);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		if (options?.recursive === false) {
			const parent = sandboxDirname(resolved);
			if (parent !== resolved) {
				const parentInfo = await this.fileInfo(parent, context);
				if (!parentInfo.ok) {
					return err(new FileError(parentInfo.error.code, parentInfo.error.message, resolved, parentInfo.error));
				}
				if (parentInfo.value.kind !== "directory") {
					return err(new FileError("not_directory", `Parent is not a directory: ${parent}`, resolved));
				}
			}
		}
		return this.withSandbox(resolved, context, async (sandbox) => {
			await sandbox.files.createDirectories([{ path: resolved, mode: DIRECTORY_MODE }]);
			return ok(undefined);
		});
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.resolve(path);
		const aborted = abortResult<void>(context.abortSignal, resolved);
		if (aborted) return aborted;
		const info = await this.fileInfo(resolved, context);
		if (!info.ok) {
			if (info.error.code === "not_found" && options?.force) return ok(undefined);
			return err(info.error);
		}
		return this.withSandbox(resolved, context, async (sandbox) => {
			if (info.value.kind === "directory") {
				if (!options?.recursive) {
					const children = await sandbox.files.listDirectory({ path: resolved, depth: 1 });
					if (children.length > 0)
						return err(new FileError("invalid", `Directory not empty: ${resolved}`, resolved));
				}
				await sandbox.files.deleteDirectories([resolved]);
			} else {
				await sandbox.files.deleteFiles([resolved]);
			}
			return ok(undefined);
		});
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const aborted = abortResult<string>(context.abortSignal);
		if (aborted) return aborted;
		const path = joinSandboxPath([this.tempDirectory, `${prefix ?? "tmp-"}${randomUUID()}`]);
		const created = await this.createDir(path, { recursive: true }, context);
		if (!created.ok) return created;
		return ok(path);
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const filePath = joinSandboxPath([dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`]);
		const written = await this.writeFile(filePath, "", context);
		if (!written.ok) return written;
		return ok(filePath);
	}

	async cleanup(context: Context): Promise<void> {
		const sessions = [...this.activeSessions.entries()];
		this.activeSessions.clear();
		await Promise.all(
			sessions.map(async ([sessionId, sandbox]) => {
				await sandbox.commands.interrupt(sessionId).catch(() => undefined);
			}),
		);
		if (this.ownsProvider) await this.provider.close(context).catch(() => undefined);
	}

	private resolve(path: string): string {
		return resolveSandboxPath(this.cwd, path, this.homeDirectory);
	}

	/** Run one file operation against the current sandbox, mapping failures and reporting a lost sandbox. */
	private async withSandbox<T>(
		path: string,
		context: Context,
		operation: (sandbox: Sandbox) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const acquired = await this.provider.acquire(context);
		if (!acquired.ok) return err(new FileError("unknown", acquired.error.message, path, acquired.error));
		try {
			return await operation(acquired.value);
		} catch (error) {
			if (isSandboxUnavailable(error)) this.provider.invalidate(acquired.value, error);
			return err(toFileError(error, path));
		}
	}

	/** Run a short, non-interactive utility through the plain command API, collecting its streams. */
	private async runUtility(
		commandLine: string,
		path: string,
		context: Context,
	): Promise<Result<{ exitCode: number; stdout: string; stderr: string }, FileError>> {
		return this.withSandbox(path, context, async (sandbox) => {
			let stdout = "";
			let stderr = "";
			const execution = await sandbox.commands.run(
				commandLine,
				{},
				{
					onStdout: (message) => {
						stdout += message.text;
					},
					onStderr: (message) => {
						stderr += message.text;
					},
					skipAccumulation: true,
				},
			);
			return ok({ exitCode: exitCodeFromExecution(execution.exitCode, execution.error?.traceback), stdout, stderr });
		});
	}

	private async ensureShell(sandbox: Sandbox, context: Context): Promise<Result<void, ExecutionError>> {
		if (this.shellChecked.has(sandbox)) return ok(undefined);
		const info = await this.fileInfo(this.shellPath, context);
		if (!info.ok) {
			if (info.error.code === "aborted") return err(new ExecutionError("aborted", "aborted", info.error));
			if (info.error.code === "not_found") {
				return err(new ExecutionError("shell_unavailable", `Shell not found in sandbox: ${this.shellPath}`));
			}
			return err(new ExecutionError("spawn_error", info.error.message, info.error));
		}
		this.shellChecked.add(sandbox);
		return ok(undefined);
	}

	private spawnError(sandbox: Sandbox, error: unknown, cwd: string): ExecutionError {
		if (isSandboxUnavailable(error)) this.provider.invalidate(sandbox, error);
		const message = toError(error).message.toLowerCase();
		const apiText =
			error !== null && typeof error === "object" && "rawBody" in error ? JSON.stringify(error.rawBody) : "";
		if (/working directory does not exist/i.test(`${message} ${apiText}`)) {
			return new ExecutionError(
				"spawn_error",
				`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
				toError(error),
			);
		}
		return toSpawnError(error, "Failed to start command in sandbox");
	}
}

function utilityFailure(stderr: string, path: string): FileError {
	const message = stderr.trim() || "Command failed";
	const lower = message.toLowerCase();
	if (lower.includes("no such file or directory")) return new FileError("not_found", message, path);
	if (lower.includes("permission denied")) return new FileError("permission_denied", message, path);
	if (lower.includes("not a directory")) return new FileError("not_directory", message, path);
	if (lower.includes("is a directory")) return new FileError("is_directory", message, path);
	return new FileError("unknown", message, path);
}
