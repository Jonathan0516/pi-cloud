import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../context.ts";
import type { ConformanceCase } from "../../session/testing/types.ts";
import {
	type ExecutionEnv,
	type ExecutionError,
	FileError,
	getOrThrow,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputView,
} from "../../types.ts";
import { applyShellOutputUpdate } from "../../utils/output-capture.ts";
import { executeShellWithCapture } from "../../utils/shell-output.ts";

/** A fresh execution environment whose `cwd` is an empty, writable directory owned by one case. */
export interface ExecutionEnvFixture extends AsyncDisposable {
	readonly env: ExecutionEnv;
}

export interface ExecutionEnvConformanceOptions {
	/** The backend reports a shell killed by a signal as `128 + signal`. Defaults to true. */
	signalExitCodes?: boolean;
	/** `cleanup()` terminates commands that are still running. Defaults to true. */
	cleanupTerminatesCommands?: boolean;
	/** Upper bound for a command to settle after abort, cleanup, or timeout. Defaults to 10 seconds. */
	settleTimeoutMs?: number;
}

type ConformanceTest = (fixture: ExecutionEnvFixture) => Promise<void>;

function createCase(
	factory: () => Promise<ExecutionEnvFixture>,
	group: string,
	name: string,
	test: ConformanceTest,
): ConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture);
		},
	};
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			onTimeout?.();
			reject(new Error(`Timed out after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectShellOutput(
	env: ExecutionEnv,
	command: string,
	options: ShellExecOptions | undefined,
	context = BACKGROUND_CONTEXT,
): Promise<{ result: Result<ShellExecResult, ExecutionError>; output: ShellOutputView | undefined }> {
	let output: ShellOutputView | undefined;
	const result = await env.exec(
		command,
		{
			...options,
			onUpdate: (update) => {
				output = applyShellOutputUpdate(output, update);
			},
		},
		context,
	);
	return { result, output };
}

function expectFileError(result: Result<unknown, FileError>, code: FileError["code"], path?: string): FileError {
	strictEqual(result.ok, false, `Expected a ${code} FileError`);
	if (result.ok) throw new Error("unreachable");
	ok(result.error instanceof FileError, "Expected a FileError instance");
	strictEqual(result.error.name, "FileError");
	strictEqual(result.error.code, code);
	if (path !== undefined) strictEqual(result.error.path, path);
	return result.error;
}

function expectExecutionError(
	result: Result<ShellExecResult, ExecutionError>,
	code: ExecutionError["code"],
): ExecutionError {
	strictEqual(result.ok, false, `Expected a ${code} ExecutionError`);
	if (result.ok) throw new Error("unreachable");
	strictEqual(result.error.name, "ExecutionError");
	strictEqual(result.error.code, code);
	return result.error;
}

async function waitForPath(env: ExecutionEnv, path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getOrThrow(await env.exists(path, BACKGROUND_CONTEXT))) return true;
		await sleep(20);
	}
	return getOrThrow(await env.exists(path, BACKGROUND_CONTEXT));
}

/**
 * Creates fresh, runner-independent cases for the {@link ExecutionEnv} contract. Every case works
 * inside the fixture's `cwd`, addresses paths relative to it, and needs `ln`, `printf`, `sleep`,
 * `yes`, and `head` in the environment's shell.
 */
export function createExecutionEnvConformance(
	factory: () => Promise<ExecutionEnvFixture>,
	options: ExecutionEnvConformanceOptions = {},
): readonly ConformanceCase[] {
	const settleTimeoutMs = options.settleTimeoutMs ?? 10_000;
	const cases: ConformanceCase[] = [
		createCase(factory, "paths", "resolves relative paths against cwd and joins segments", async ({ env }) => {
			const absolute = getOrThrow(await env.absolutePath("nested/child", BACKGROUND_CONTEXT));
			const joined = getOrThrow(await env.joinPath([env.cwd, "nested", "child"], BACKGROUND_CONTEXT));
			strictEqual(absolute, joined);
			strictEqual(getOrThrow(await env.absolutePath(absolute, BACKGROUND_CONTEXT)), absolute);
			strictEqual(getOrThrow(await env.absolutePath(".", BACKGROUND_CONTEXT)), env.cwd);
		}),

		createCase(factory, "files", "reads, writes, lists, and removes files and directories", async ({ env }) => {
			getOrThrow(await env.createDir("nested/child", undefined, BACKGROUND_CONTEXT));
			getOrThrow(await env.writeFile("nested/child/file.txt", "hel", BACKGROUND_CONTEXT));
			getOrThrow(await env.appendFile("nested/child/file.txt", "lo", BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.readTextFile("nested/child/file.txt", BACKGROUND_CONTEXT)), "hello");
			deepStrictEqual(
				getOrThrow(await env.readTextLines("nested/child/file.txt", { maxLines: 1 }, BACKGROUND_CONTEXT)),
				["hello"],
			);
			strictEqual(
				new TextDecoder().decode(getOrThrow(await env.readBinaryFile("nested/child/file.txt", BACKGROUND_CONTEXT))),
				"hello",
			);

			const entries = getOrThrow(await env.listDir("nested/child", BACKGROUND_CONTEXT));
			strictEqual(entries.length, 1);
			const expectedPath = getOrThrow(await env.absolutePath("nested/child/file.txt", BACKGROUND_CONTEXT));
			strictEqual(entries[0]!.name, "file.txt");
			strictEqual(entries[0]!.path, expectedPath);
			strictEqual(entries[0]!.kind, "file");
			strictEqual(entries[0]!.size, 5);
			strictEqual(typeof entries[0]!.mtimeMs, "number");
			ok(Number.isFinite(entries[0]!.mtimeMs));

			strictEqual(getOrThrow(await env.exists("nested/child/file.txt", BACKGROUND_CONTEXT)), true);
			getOrThrow(await env.remove("nested/child/file.txt", undefined, BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.exists("nested/child/file.txt", BACKGROUND_CONTEXT)), false);
		}),

		createCase(factory, "files", "writes and reads binary content exactly", async ({ env }) => {
			const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index);
			getOrThrow(await env.writeFile("bytes.bin", bytes, BACKGROUND_CONTEXT));
			deepStrictEqual([...getOrThrow(await env.readBinaryFile("bytes.bin", BACKGROUND_CONTEXT))], [...bytes]);
			getOrThrow(await env.appendFile("bytes.bin", Uint8Array.from([1, 2, 3]), BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.fileInfo("bytes.bin", BACKGROUND_CONTEXT)).size, 259);
		}),

		createCase(factory, "files", "appends to new files and creates parent directories", async ({ env }) => {
			getOrThrow(await env.appendFile("new/nested/file.txt", "a", BACKGROUND_CONTEXT));
			getOrThrow(await env.appendFile("new/nested/file.txt", "b", BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.readTextFile("new/nested/file.txt", BACKGROUND_CONTEXT)), "ab");
			getOrThrow(await env.writeFile("other/deeper/file.txt", "c", BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.readTextFile("other/deeper/file.txt", BACKGROUND_CONTEXT)), "c");
		}),

		createCase(factory, "files", "reads text lines with termination and honors the line limit", async ({ env }) => {
			getOrThrow(await env.writeFile("file.txt", "one\ntwo\nthree", BACKGROUND_CONTEXT));
			deepStrictEqual(getOrThrow(await env.readTextLines("file.txt", { maxLines: 1 }, BACKGROUND_CONTEXT)), ["one"]);
			deepStrictEqual(getOrThrow(await env.readTextLines("file.txt", undefined, BACKGROUND_CONTEXT)), [
				"one",
				"two",
				"three",
			]);
			deepStrictEqual(getOrThrow(await env.readTextLines("file.txt", { maxLines: 0 }, BACKGROUND_CONTEXT)), []);

			const reader = getOrThrow(await env.openTextLineReader("file.txt", BACKGROUND_CONTEXT));
			try {
				deepStrictEqual(getOrThrow(await reader.readLine(BACKGROUND_CONTEXT)), { text: "one", terminated: true });
				deepStrictEqual(getOrThrow(await reader.readLine(BACKGROUND_CONTEXT)), { text: "two", terminated: true });
				deepStrictEqual(getOrThrow(await reader.readLine(BACKGROUND_CONTEXT)), {
					text: "three",
					terminated: false,
				});
				strictEqual(getOrThrow(await reader.readLine(BACKGROUND_CONTEXT)), undefined);
			} finally {
				await reader.close(BACKGROUND_CONTEXT);
			}
		}),

		createCase(factory, "files", "returns not_found for missing paths and false from exists", async ({ env }) => {
			const missing = getOrThrow(await env.absolutePath("missing.txt", BACKGROUND_CONTEXT));
			expectFileError(await env.fileInfo("missing.txt", BACKGROUND_CONTEXT), "not_found", missing);
			expectFileError(await env.readTextFile("missing.txt", BACKGROUND_CONTEXT), "not_found");
			expectFileError(await env.readBinaryFile("missing.txt", BACKGROUND_CONTEXT), "not_found");
			expectFileError(await env.listDir("missing-dir", BACKGROUND_CONTEXT), "not_found");
			expectFileError(await env.canonicalPath("missing.txt", BACKGROUND_CONTEXT), "not_found");
			strictEqual(getOrThrow(await env.exists("missing.txt", BACKGROUND_CONTEXT)), false);
		}),

		createCase(factory, "files", "distinguishes files from directories in errors", async ({ env }) => {
			getOrThrow(await env.writeFile("file.txt", "hello", BACKGROUND_CONTEXT));
			getOrThrow(await env.createDir("dir", undefined, BACKGROUND_CONTEXT));
			expectFileError(await env.listDir("file.txt", BACKGROUND_CONTEXT), "not_directory");
			expectFileError(await env.readTextFile("dir", BACKGROUND_CONTEXT), "is_directory");
		}),

		createCase(factory, "files", "renames a file and replaces the destination", async ({ env }) => {
			getOrThrow(await env.writeFile("source.txt", "new", BACKGROUND_CONTEXT));
			getOrThrow(await env.writeFile("destination.txt", "old", BACKGROUND_CONTEXT));

			getOrThrow(await env.renameFile("source.txt", "destination.txt", BACKGROUND_CONTEXT));

			strictEqual(getOrThrow(await env.exists("source.txt", BACKGROUND_CONTEXT)), false);
			strictEqual(getOrThrow(await env.readTextFile("destination.txt", BACKGROUND_CONTEXT)), "new");
		}),

		createCase(
			factory,
			"files",
			"reports the source path when rename fails because the source is missing",
			async ({ env }) => {
				getOrThrow(await env.writeFile("destination.txt", "unchanged", BACKGROUND_CONTEXT));
				const source = getOrThrow(await env.absolutePath("missing-source.txt", BACKGROUND_CONTEXT));

				expectFileError(
					await env.renameFile("missing-source.txt", "destination.txt", BACKGROUND_CONTEXT),
					"not_found",
					source,
				);
				strictEqual(getOrThrow(await env.readTextFile("destination.txt", BACKGROUND_CONTEXT)), "unchanged");
			},
		),

		createCase(factory, "files", "creates temporary directories and files", async ({ env }) => {
			const tempDir = getOrThrow(await env.createTempDir("env-conformance-", BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.fileInfo(tempDir, BACKGROUND_CONTEXT)).kind, "directory");
			const tempFile = getOrThrow(
				await env.createTempFile({ prefix: "prefix-", suffix: ".txt" }, BACKGROUND_CONTEXT),
			);
			strictEqual(getOrThrow(await env.fileInfo(tempFile, BACKGROUND_CONTEXT)).kind, "file");
			ok(tempFile.endsWith(".txt"));
			const other = getOrThrow(await env.createTempFile(undefined, BACKGROUND_CONTEXT));
			ok(other !== tempFile);
		}),

		createCase(factory, "files", "honors createDir recursive false and remove options", async ({ env }) => {
			expectFileError(await env.createDir("missing/child", { recursive: false }, BACKGROUND_CONTEXT), "not_found");
			getOrThrow(await env.createDir("present", { recursive: false }, BACKGROUND_CONTEXT));

			getOrThrow(await env.writeFile("dir/child/file.txt", "hello", BACKGROUND_CONTEXT));
			strictEqual((await env.remove("dir", { recursive: false }, BACKGROUND_CONTEXT)).ok, false);
			strictEqual(getOrThrow(await env.exists("dir/child/file.txt", BACKGROUND_CONTEXT)), true);
			getOrThrow(await env.remove("dir", { recursive: true }, BACKGROUND_CONTEXT));
			strictEqual(getOrThrow(await env.exists("dir", BACKGROUND_CONTEXT)), false);

			expectFileError(await env.remove("missing", { force: false }, BACKGROUND_CONTEXT), "not_found");
			getOrThrow(await env.remove("missing", { force: true }, BACKGROUND_CONTEXT));
		}),

		createCase(
			factory,
			"files",
			"returns aborted results for pre-aborted cancellable file operations",
			async ({ env }) => {
				getOrThrow(await env.writeFile("file.txt", "hello", BACKGROUND_CONTEXT));
				const controller = new AbortController();
				controller.abort();
				const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);

				const results: Result<unknown, FileError>[] = await Promise.all([
					env.readTextFile("file.txt", context),
					env.readTextLines("file.txt", undefined, context),
					env.readBinaryFile("file.txt", context),
					env.writeFile("other.txt", "hello", context),
					env.renameFile("file.txt", "renamed.txt", context),
					env.listDir(".", context),
					env.fileInfo("file.txt", context),
				]);
				for (const result of results) expectFileError(result, "aborted");
				strictEqual(getOrThrow(await env.exists("file.txt", BACKGROUND_CONTEXT)), true);
				strictEqual(getOrThrow(await env.exists("other.txt", BACKGROUND_CONTEXT)), false);
			},
		),

		createCase(factory, "files", "cleanup is best-effort", async ({ env }) => {
			strictEqual(await env.cleanup(BACKGROUND_CONTEXT), undefined);
		}),

		createCase(
			factory,
			"symlinks",
			"returns fileInfo for files, directories, and symlinks without following symlinks",
			async ({ env }) => {
				getOrThrow(await env.createDir("dir", { recursive: true }, BACKGROUND_CONTEXT));
				getOrThrow(await env.writeFile("dir/file.txt", "hello", BACKGROUND_CONTEXT));
				const linked = getOrThrow(
					await env.exec("ln -s dir/file.txt file-link && ln -s dir dir-link", undefined, BACKGROUND_CONTEXT),
				);
				strictEqual(linked.exitCode, 0);

				const dir = getOrThrow(await env.fileInfo("dir", BACKGROUND_CONTEXT));
				strictEqual(dir.name, "dir");
				strictEqual(dir.kind, "directory");
				strictEqual(dir.path, getOrThrow(await env.absolutePath("dir", BACKGROUND_CONTEXT)));
				const file = getOrThrow(await env.fileInfo("dir/file.txt", BACKGROUND_CONTEXT));
				strictEqual(file.kind, "file");
				strictEqual(file.size, 5);
				strictEqual(getOrThrow(await env.fileInfo("file-link", BACKGROUND_CONTEXT)).kind, "symlink");
				strictEqual(getOrThrow(await env.fileInfo("dir-link", BACKGROUND_CONTEXT)).kind, "symlink");
				strictEqual(
					getOrThrow(await env.canonicalPath("file-link", BACKGROUND_CONTEXT)),
					getOrThrow(await env.canonicalPath("dir/file.txt", BACKGROUND_CONTEXT)),
				);
			},
		),

		createCase(factory, "symlinks", "lists symlinks as symlinks", async ({ env }) => {
			getOrThrow(await env.writeFile("target.txt", "hello", BACKGROUND_CONTEXT));
			strictEqual(
				getOrThrow(await env.exec("ln -s target.txt link.txt", undefined, BACKGROUND_CONTEXT)).exitCode,
				0,
			);

			const entries = getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT));
			deepStrictEqual(
				entries
					.map((entry) => ({ name: entry.name, kind: entry.kind }))
					.sort((left, right) => left.name.localeCompare(right.name)),
				[
					{ name: "link.txt", kind: "symlink" },
					{ name: "target.txt", kind: "file" },
				],
			);
		}),

		createCase(factory, "shell", "executes commands in cwd with env overrides", async ({ env }) => {
			const collected = await collectShellOutput(env, 'printf \'%s:%s\' "$PWD" "$PI_ENV_CONFORMANCE"', {
				env: { PI_ENV_CONFORMANCE: "ok" },
			});
			const result = getOrThrow(collected.result);
			strictEqual(result.exitCode, 0);
			strictEqual(collected.output?.text, `${getOrThrow(await env.canonicalPath(env.cwd, BACKGROUND_CONTEXT))}:ok`);
		}),

		createCase(factory, "shell", "runs in an explicit working directory relative to cwd", async ({ env }) => {
			getOrThrow(await env.createDir("sub", undefined, BACKGROUND_CONTEXT));
			const collected = await collectShellOutput(env, "printf '%s' \"$PWD\"", { cwd: "sub" });
			getOrThrow(collected.result);
			strictEqual(collected.output?.text, getOrThrow(await env.canonicalPath("sub", BACKGROUND_CONTEXT)));
		}),

		createCase(factory, "shell", "can replace rather than inherit the default shell environment", async ({ env }) => {
			const collected = await collectShellOutput(env, `printf '%s:%s' "\${HOME-}" "\${PI_ENV_EXPLICIT-}"`, {
				inheritEnv: false,
				env: { PI_ENV_EXPLICIT: "explicit" },
			});
			getOrThrow(collected.result);
			strictEqual(collected.output?.text, ":explicit");
		}),

		createCase(factory, "shell", "combines stdout and stderr into one bounded view", async ({ env }) => {
			const kinds: string[] = [];
			let output: ShellOutputView | undefined;
			const result = getOrThrow(
				await env.exec(
					"printf out; printf err >&2",
					{
						onUpdate: (update) => {
							kinds.push(update.kind);
							output = applyShellOutputUpdate(output, update);
						},
					},
					BACKGROUND_CONTEXT,
				),
			);
			strictEqual(result.exitCode, 0);
			ok(output?.text.includes("out"));
			ok(output?.text.includes("err"));
			strictEqual(kinds[0], "replace");
			strictEqual(result.truncation.totalBytes, 6);
		}),

		createCase(factory, "shell", "reports a missing working directory before running", async ({ env }) => {
			const error = expectExecutionError(
				await env.exec("printf ok", { cwd: "missing" }, BACKGROUND_CONTEXT),
				"spawn_error",
			);
			match(error.message, /Working directory does not exist/);
		}),

		createCase(
			factory,
			"shell",
			"returns non-zero command exit codes as successful execution results",
			async ({ env }) => {
				const result = getOrThrow(await env.exec("exit 7", undefined, BACKGROUND_CONTEXT));
				strictEqual(result.exitCode, 7);
				strictEqual(result.truncation.totalBytes, 0);
			},
		),

		createCase(factory, "shell", "returns timeout errors for commands exceeding the timeout", async ({ env }) => {
			const started = Date.now();
			const result = await withTimeout(env.exec("sleep 5", { timeout: 0.05 }, BACKGROUND_CONTEXT), settleTimeoutMs);
			expectExecutionError(result, "timeout");
			ok(Date.now() - started < settleTimeoutMs);
		}),

		createCase(factory, "shell", "rejects invalid timeouts without running", async ({ env }) => {
			expectExecutionError(await env.exec("touch ran", { timeout: 0 }, BACKGROUND_CONTEXT), "timeout");
			expectExecutionError(await env.exec("touch ran", { timeout: Number.NaN }, BACKGROUND_CONTEXT), "timeout");
			strictEqual(getOrThrow(await env.exists("ran", BACKGROUND_CONTEXT)), false);
		}),

		createCase(factory, "shell", "returns callback errors from exec stream handlers", async ({ env }) => {
			const error = expectExecutionError(
				await env.exec(
					"printf out",
					{
						onUpdate: () => {
							throw new Error("callback failed");
						},
					},
					BACKGROUND_CONTEXT,
				),
				"callback_error",
			);
			strictEqual(error.message, "callback failed");
		}),

		createCase(factory, "shell", "returns an aborted result for aborted commands", async ({ env }) => {
			const controller = new AbortController();
			const promise = env.exec("sleep 30", undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
			controller.abort();
			expectExecutionError(await withTimeout(promise, settleTimeoutMs), "aborted");

			const preAborted = new AbortController();
			preAborted.abort();
			expectExecutionError(
				await env.exec("touch ran", undefined, withAbortSignal(preAborted.signal, BACKGROUND_CONTEXT)),
				"aborted",
			);
			strictEqual(getOrThrow(await env.exists("ran", BACKGROUND_CONTEXT)), false);
		}),

		createCase(factory, "shell", "aborts a command that already produced output", async ({ env }) => {
			const controller = new AbortController();
			const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
			let output: ShellOutputView | undefined;
			const promise = env.exec(
				"printf started; touch started; sleep 30; printf finished",
				{
					onUpdate: (update) => {
						output = applyShellOutputUpdate(output, update);
					},
				},
				context,
			);
			ok(await waitForPath(env, "started", settleTimeoutMs), "command never started");
			// Line-oriented transports publish a partial line on a short timer; give it one tick.
			await sleep(500);
			controller.abort();
			expectExecutionError(await withTimeout(promise, settleTimeoutMs), "aborted");
			ok(output?.text.includes("started"));
			ok(!output?.text.includes("finished"));
		}),

		createCase(
			factory,
			"shell",
			"does not create a spill before bounded output crosses its limits",
			async ({ env }) => {
				const result = getOrThrow(
					await env.exec(
						"printf short",
						{
							capture: { limits: { maxBytes: 100, maxLines: 10, retain: "tail" }, spill: true },
							onUpdate: () => {},
						},
						BACKGROUND_CONTEXT,
					),
				);
				strictEqual(result.spillPath, undefined);
				strictEqual(result.truncation.truncated, false);
			},
		),

		createCase(
			factory,
			"shell",
			"preserves complete output in the spill once limits are crossed",
			async ({ env }) => {
				const lines = Array.from({ length: 30 }, (_value, index) => `line ${index + 1}`);
				let output: ShellOutputView | undefined;
				const result = getOrThrow(
					await env.exec(
						`for i in $(seq 1 30); do echo "line $i"; done`,
						{
							capture: { limits: { maxBytes: 10_000, maxLines: 10, retain: "tail" }, spill: true },
							onUpdate: (update) => {
								output = applyShellOutputUpdate(output, update);
							},
						},
						BACKGROUND_CONTEXT,
					),
				);
				strictEqual(result.truncation.truncated, true);
				strictEqual(result.truncation.totalLines, 30);
				ok(result.spillPath !== undefined, "expected a spill path");
				strictEqual(output?.spillPath, result.spillPath);
				strictEqual(
					getOrThrow(await env.readTextFile(result.spillPath!, BACKGROUND_CONTEXT)),
					`${lines.join("\n")}\n`,
				);
				ok(output !== undefined && output.text.split("\n").filter((line) => line !== "").length <= 10);
				ok(output?.text.includes("line 30"));
				ok(!output?.text.includes("line 1\n"));
			},
		),

		createCase(
			factory,
			"shell",
			"captures large shell output to a full output file through executeShellWithCapture",
			async ({ env }) => {
				const result = getOrThrow(
					await executeShellWithCapture(env, "yes line | head -n 15000", undefined, BACKGROUND_CONTEXT),
				);
				strictEqual(result.truncated, true);
				ok(result.fullOutputPath !== undefined, "expected a full output path");
				const fullOutput = getOrThrow(await env.readTextFile(result.fullOutputPath!, BACKGROUND_CONTEXT));
				strictEqual(fullOutput.split("\n").length, 15_001);
				ok(result.output.length < fullOutput.length);
			},
		),
	];

	if (options.signalExitCodes ?? true) {
		cases.push(
			createCase(factory, "shell", "maps signal-killed processes to a non-zero exit code", async ({ env }) => {
				const result = getOrThrow(await env.exec("kill -9 $$", undefined, BACKGROUND_CONTEXT));
				strictEqual(result.exitCode, 128 + 9);
			}),
		);
	}

	if (options.cleanupTerminatesCommands ?? true) {
		cases.push(
			createCase(factory, "cancellation", "cleanup terminates active shell processes", async ({ env }) => {
				const execution = env.exec("touch started; sleep 60", undefined, BACKGROUND_CONTEXT);
				ok(await waitForPath(env, "started", settleTimeoutMs), "command never started");
				await env.cleanup(BACKGROUND_CONTEXT);
				const result = await withTimeout(execution, settleTimeoutMs);
				strictEqual(result.ok, true);
			}),
		);
	}

	return cases;
}
