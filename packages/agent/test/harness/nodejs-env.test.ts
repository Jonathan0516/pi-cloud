import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { type ConformanceCase, createExecutionEnvConformance } from "../../src/harness/env/testing/index.ts";
import { getOrThrow, type ShellExecOptions, type ShellOutputView } from "../../src/harness/types.ts";
import { applyShellOutputUpdate } from "../../src/harness/utils/output-capture.ts";
import { createTempDir } from "./session-test-utils.ts";

const chmodRestorePaths: string[] = [];

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

async function collectShellOutput(
	env: NodeExecutionEnv,
	command: string,
	options: ShellExecOptions | undefined,
	context: Parameters<NodeExecutionEnv["exec"]>[2],
): Promise<{ result: Awaited<ReturnType<NodeExecutionEnv["exec"]>>; output: ShellOutputView | undefined }> {
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

function toBashSingleQuotedArg(value: string): string {
	return `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
}

function createInheritedStdioCommand(pidFile: string): string {
	return (
		'node -e "' +
		"const fs=require('fs');" +
		"const {spawn}=require('child_process');" +
		"const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit',detached:true});" +
		"fs.writeFileSync(process.argv[1], String(child.pid));" +
		"child.unref();" +
		"console.log('child-exiting');" +
		'" ' +
		toBashSingleQuotedArg(pidFile)
	);
}

function cleanupDetachedChild(pidFile: string): void {
	if (!existsSync(pidFile)) return;
	const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
	if (!Number.isFinite(pid) || pid <= 0) return;
	try {
		execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
	} catch {}
}

class FailingSpillExecutionEnv extends NodeExecutionEnv {
	override async createTempFile(
		options: Parameters<NodeExecutionEnv["createTempFile"]>[0],
		context: Parameters<NodeExecutionEnv["createTempFile"]>[1],
	) {
		if (options?.prefix === "pi-output-") {
			return { ok: true as const, value: join(this.cwd, "missing", "spill.log") };
		}
		return super.createTempFile(options, context);
	}
}

afterEach(async () => {
	for (const path of chmodRestorePaths.splice(0)) {
		try {
			await access(path);
			await chmod(path, 0o700);
		} catch {}
	}
});

function registerConformance(name: string, cases: readonly ConformanceCase[]): void {
	describe(name, () => {
		for (const group of new Set(cases.map((testCase) => testCase.group))) {
			describe(group, () => {
				for (const testCase of cases.filter((candidate) => candidate.group === group)) {
					it(testCase.name, () => testCase.run());
				}
			});
		}
	});
}

registerConformance(
	"NodeExecutionEnv conformance",
	createExecutionEnvConformance(
		async () => {
			const env = new NodeExecutionEnv({ cwd: createTempDir() });
			return {
				env,
				async [Symbol.asyncDispose]() {
					await env.cleanup(BACKGROUND_CONTEXT);
				},
			};
		},
		{ signalExitCodes: process.platform !== "win32" },
	),
);

describe("NodeExecutionEnv", () => {
	it("expands home-relative paths and file URLs", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		expect(getOrThrow(await env.absolutePath("~/pi-node-env-test", BACKGROUND_CONTEXT))).toBe(
			join(homedir(), "pi-node-env-test"),
		);
		const filePath = join(root, "file with spaces.txt");
		expect(getOrThrow(await env.absolutePath(pathToFileURL(filePath).href, BACKGROUND_CONTEXT))).toBe(filePath);
	});

	it.each([
		["a missing override preserves the base value", undefined, "x:/stale/parent.jsonl"],
		["an empty override shadows the base value", { PI_SESSION_FILE: "" }, "x:"],
		[
			"a string override replaces the base value",
			{ PI_SESSION_FILE: "/sessions/current.jsonl" },
			"x:/sessions/current.jsonl",
		],
	] as const)(
		"applies string shell environment overrides when %s",
		async (_description, overrides, expectedSessionFile) => {
			const root = createTempDir();
			const env = new NodeExecutionEnv({
				cwd: root,
				shellEnv: {
					PI_SESSION_FILE: "/stale/parent.jsonl",
					PI_CODING_AGENT: "true",
					PI_NODE_ENV_PRESERVED_TEST: "preserved",
				},
			});
			const collected = await collectShellOutput(
				env,
				`printf '%s:%s|%s|%s' "\${PI_SESSION_FILE+x}" "\${PI_SESSION_FILE-}" "$PI_CODING_AGENT" "$PI_NODE_ENV_PRESERVED_TEST"`,
				{ env: overrides },
				BACKGROUND_CONTEXT,
			);
			getOrThrow(collected.result);
			expect(collected.output?.text).toBe(`${expectedSessionFile}|true|preserved`);
		},
	);

	it("can replace rather than inherit the default shell environment", async () => {
		const root = createTempDir();
		const inheritedKey = "PI_NODE_ENV_INHERITED_TEST";
		const configuredKey = "PI_NODE_ENV_CONFIGURED_TEST";
		const explicitKey = "PI_NODE_ENV_EXPLICIT_TEST";
		const previousInherited = process.env[inheritedKey];
		process.env[inheritedKey] = "host";
		try {
			const env = new NodeExecutionEnv({ cwd: root, shellEnv: { [configuredKey]: "configured" } });
			const collected = await collectShellOutput(
				env,
				`printf '%s:%s:%s' "\${${inheritedKey}-}" "\${${configuredKey}-}" "\${${explicitKey}-}"`,
				{ inheritEnv: false, env: { [explicitKey]: "explicit" } },
				BACKGROUND_CONTEXT,
			);
			getOrThrow(collected.result);
			expect(collected.output?.text).toBe("::explicit");
		} finally {
			if (previousInherited === undefined) delete process.env[inheritedKey];
			else process.env[inheritedKey] = previousInherited;
		}
	});

	it("uses stdin command transport for legacy WSL bash paths", async () => {
		if (process.platform === "win32") return;
		const root = createTempDir();
		const shellPath = "C:\\Windows\\System32\\bash.exe";
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(
			await env.writeFile(
				shellPath,
				'#!/bin/sh\nprintf \'args:%s\\n\' "$*" >&2\nexec /bin/bash "$@"\n',
				BACKGROUND_CONTEXT,
			),
		);
		await chmod(join(root, shellPath), 0o755);

		const originalCwd = process.cwd();
		const originalPath = process.env.PATH;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			process.chdir(root);
			process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
			Object.defineProperty(process, "platform", {
				configurable: true,
				value: "win32",
			});

			const wslEnv = new NodeExecutionEnv({ cwd: root, shellPath });
			const nameExpansion = "$" + "{name}";
			const collected = await collectShellOutput(
				wslEnv,
				`name='World'; echo "Hello, ${nameExpansion}!"`,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const result = getOrThrow(collected.result);
			expect(collected.output?.text).toContain("Hello, World!");
			expect(collected.output?.text).toContain("args:-s");
			expect(result.exitCode).toBe(0);
		} finally {
			process.chdir(originalCwd);
			process.env.PATH = originalPath;
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}
	});

	it.skipIf(process.platform !== "win32")(
		"settles after the shell exits when a detached descendant retains inherited stdio",
		async () => {
			const root = createTempDir();
			const pidFile = join(root, "grandchild.pid");
			const env = new NodeExecutionEnv({ cwd: root });
			const controller = new AbortController();
			try {
				const collected = await withTimeout(
					collectShellOutput(
						env,
						createInheritedStdioCommand(pidFile),
						undefined,
						withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
					),
					3000,
					() => controller.abort(),
				);
				getOrThrow(collected.result);
				expect(collected.output?.text).toContain("child-exiting");
			} finally {
				controller.abort();
				cleanupDetachedChild(pidFile);
			}
		},
	);

	it("returns shell unavailable and spawn errors", async () => {
		const root = createTempDir();
		const missingShellEnv = new NodeExecutionEnv({ cwd: root, shellPath: join(root, "missing-shell") });
		const missingShell = await missingShellEnv.exec("printf ok", undefined, BACKGROUND_CONTEXT);
		expect(missingShell.ok).toBe(false);
		if (!missingShell.ok) expect(missingShell.error).toMatchObject({ code: "shell_unavailable" });

		const shellPath = join(root, "not-executable-shell");
		const env = new NodeExecutionEnv({ cwd: root });
		getOrThrow(await env.writeFile(shellPath, "not executable", BACKGROUND_CONTEXT));
		const spawnErrorEnv = new NodeExecutionEnv({ cwd: root, shellPath });
		const spawnError = await spawnErrorEnv.exec("printf ok", undefined, BACKGROUND_CONTEXT);
		expect(spawnError.ok).toBe(false);
		if (!spawnError.ok) expect(spawnError.error).toMatchObject({ code: "spawn_error" });
	});

	it.skipIf(process.platform === "win32")("ignores asynchronous taskkill spawn errors during abort", async () => {
		const root = createTempDir();
		const pidFile = join(root, "shell.pid");
		const controller = new AbortController();
		const env = new NodeExecutionEnv({ cwd: root, shellPath: "/bin/bash" });
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const previousSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "/definitely/missing/windows";
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });

		let pid: number | undefined;
		try {
			const execution = env.exec(
				`echo $$ > ${toBashSingleQuotedArg(pidFile)}; exec sleep 60`,
				undefined,
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(existsSync(pidFile)).toBe(true);

			controller.abort();
			await new Promise((resolve) => setTimeout(resolve, 0));
			pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			process.kill(pid, "SIGKILL");

			const result = await execution;
			expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
		} finally {
			if (pid === undefined && existsSync(pidFile)) {
				pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
			}
			if (pid !== undefined && Number.isFinite(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("preserves exact raw bytes in the spill while decoding a bounded text view", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const expected = [0x66, 0x80, 0x00, 0x6f];
		const result = getOrThrow(
			await env.exec(
				`${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([${expected.join(",")}]))"`,
				{
					capture: { limits: { maxBytes: 1, maxLines: 10, retain: "tail" }, spill: true },
					onUpdate: () => {},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.spillPath).toBeDefined();
		expect([...getOrThrow(await env.readBinaryFile(result.spillPath!, BACKGROUND_CONTEXT))]).toEqual(expected);
	});

	it("fails rather than silently losing a requested spill", async () => {
		const root = createTempDir();
		const env = new FailingSpillExecutionEnv({ cwd: root });
		const result = await env.exec(
			"printf 12345678901234567890",
			{
				capture: { limits: { maxBytes: 10, maxLines: 10, retain: "tail" }, spill: true },
				onUpdate: () => {},
			},
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "unknown", message: expect.stringContaining("Failed to preserve complete shell output") },
		});
	});

	it("preserves complete output when spill-stream backpressure pauses a process that exits quickly", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const size = 500_000;
		const result = getOrThrow(
			await env.exec(
				`${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(${size}))"`,
				{
					capture: { limits: { maxBytes: 10, maxLines: 10, retain: "tail" }, spill: true },
					onUpdate: () => {},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.spillPath).toBeDefined();
		expect(getOrThrow(await env.readTextFile(result.spillPath!, BACKGROUND_CONTEXT))).toHaveLength(size);
	});
});
