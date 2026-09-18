import { randomUUID } from "node:crypto";
import { ConnectionConfig } from "@alibaba-group/opensandbox";
import {
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	getOrThrow,
	type ShellOutputView,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildShellInvocation,
	decodeTransportedLine,
	exitCodeFromExecution,
	LazySandboxProvider,
	OpenSandboxExecutionEnv,
	shellQuote,
} from "../src/index.ts";
import { connectionConfig, createSpec, describeSandbox, sharedSandbox } from "./support.ts";

describe("shell wrapping", () => {
	it("quotes for POSIX shells", () => {
		expect(shellQuote("plain")).toBe("'plain'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	it("builds inherited and isolated invocations", () => {
		expect(buildShellInvocation("/bin/bash", 'echo "$A"', { A: "x y" }, true, { lineTransport: false })).toEqual({
			commandLine: `A='x y' '/bin/bash' -c 'echo "$A"'`,
		});
		expect(buildShellInvocation("/bin/bash", "pwd", undefined, false, { lineTransport: false })).toEqual({
			commandLine: `env -i '/bin/bash' -c 'pwd'`,
		});
		const transported = buildShellInvocation("/bin/bash", "pwd", undefined, true);
		expect("commandLine" in transported && transported.commandLine).toContain("PIPESTATUS[0]");
		expect(buildShellInvocation("/bin/bash", "pwd", { "BAD NAME": "x" }, true)).toEqual({
			error: "Invalid environment variable name: BAD NAME",
		});
	});

	it("decodes tagged transport lines", () => {
		expect(decodeTransportedLine("Lhello")).toBe("hello\n");
		expect(decodeTransportedLine("L")).toBe("\n");
		expect(decodeTransportedLine("Ptail")).toBe("tail");
		expect(decodeTransportedLine("untagged")).toBe("untagged");
	});

	it("maps execd exit reports", () => {
		expect(exitCodeFromExecution(7, ["exit status 7"])).toBe(7);
		expect(exitCodeFromExecution(-1, ["signal: killed"])).toBe(137);
		expect(exitCodeFromExecution(-1, ["signal: terminated"])).toBe(143);
		expect(exitCodeFromExecution(null, undefined)).toBe(1);
	});
});

describeSandbox("OpenSandboxExecutionEnv with a lazy provider", () => {
	it("provisions on first use, reconnects by id, and runs the provisioning hook", async () => {
		const events: string[] = [];
		const first = new LazySandboxProvider({
			connectionConfig: connectionConfig(),
			create: createSpec(),
			onProvisioned: async (_sandbox, event) => {
				events.push(event.reason);
			},
		});
		const env = new OpenSandboxExecutionEnv({ provider: first, cwd: "/workspace" });
		try {
			expect(first.isProvisioned).toBe(false);
			const marker = `marker-${randomUUID()}.txt`;
			getOrThrow(await env.writeFile(marker, "hello", BACKGROUND_CONTEXT));
			expect(first.isProvisioned).toBe(true);
			expect(events).toEqual(["created"]);

			const second = new LazySandboxProvider({
				connectionConfig: connectionConfig(),
				create: createSpec(),
				sandboxId: first.sandboxId,
				onProvisioned: async (_sandbox, event) => {
					events.push(event.reason);
				},
			});
			const reconnected = new OpenSandboxExecutionEnv({ provider: second, cwd: "/workspace" });
			try {
				expect(getOrThrow(await reconnected.readTextFile(marker, BACKGROUND_CONTEXT))).toBe("hello");
				expect(second.sandboxId).toBe(first.sandboxId);
				expect(events).toEqual(["created", "connected"]);
			} finally {
				await reconnected.cleanup(BACKGROUND_CONTEXT);
			}
		} finally {
			const provider = new LazySandboxProvider({
				connectionConfig: connectionConfig(),
				create: createSpec(),
				sandboxId: first.sandboxId,
				killOnClose: true,
			});
			const killer = new OpenSandboxExecutionEnv({ provider, cwd: "/workspace" });
			getOrThrow(await killer.exists("/workspace", BACKGROUND_CONTEXT));
			await killer.cleanup(BACKGROUND_CONTEXT);
			await env.cleanup(BACKGROUND_CONTEXT);
		}
	});

	it("reports an unreachable server as a spawn error without hanging", async () => {
		const provider = new LazySandboxProvider({
			connectionConfig: new ConnectionConfig({ domain: "127.0.0.1:1", apiKey: "none", requestTimeoutSeconds: 5 }),
			create: createSpec(),
		});
		const env = new OpenSandboxExecutionEnv({ provider, cwd: "/workspace" });
		const result = await env.exec("printf ok", undefined, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: false, error: { code: "spawn_error" } });
		const read = await env.readTextFile("missing.txt", BACKGROUND_CONTEXT);
		expect(read).toMatchObject({ ok: false, error: { code: "unknown" } });
		await env.cleanup(BACKGROUND_CONTEXT);
	});
});

describeSandbox("OpenSandboxExecutionEnv specifics", () => {
	it("applies baseline shell variables under per-call overrides", async () => {
		const sandbox = await sharedSandbox();
		const env = new OpenSandboxExecutionEnv({
			provider: sandbox,
			cwd: "/workspace",
			shellEnv: { PI_BASE: "base", PI_OVERRIDDEN: "base" },
		});
		let output: ShellOutputView | undefined;
		const result = getOrThrow(
			await env.exec(
				'printf \'%s|%s|%s\' "$PI_BASE" "$PI_OVERRIDDEN" "$HOME"',
				{
					env: { PI_OVERRIDDEN: "call" },
					onUpdate: (update) => {
						output = applyShellOutputUpdate(output, update);
					},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(result.exitCode).toBe(0);
		expect(output?.text).toBe("base|call|/root");
	});

	it("rejects invalid environment variable names before running", async () => {
		const sandbox = await sharedSandbox();
		const env = new OpenSandboxExecutionEnv({ provider: sandbox, cwd: "/workspace" });
		const result = await env.exec("touch should-not-exist", { env: { "1BAD": "x" } }, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: false, error: { code: "spawn_error" } });
		expect(getOrThrow(await env.exists("/workspace/should-not-exist", BACKGROUND_CONTEXT))).toBe(false);
	});

	it("reports a missing shell as shell_unavailable", async () => {
		const sandbox = await sharedSandbox();
		const env = new OpenSandboxExecutionEnv({
			provider: sandbox,
			cwd: "/workspace",
			shellPath: "/bin/no-such-shell",
		});
		const result = await env.exec("printf ok", undefined, BACKGROUND_CONTEXT);
		expect(result).toMatchObject({ ok: false, error: { code: "shell_unavailable" } });
	});

	it("fails loudly when a requested spill would exceed the configured cap", async () => {
		const sandbox = await sharedSandbox();
		const env = new OpenSandboxExecutionEnv({ provider: sandbox, cwd: "/workspace", maxSpillBytes: 2_000 });
		const result = await env.exec(
			"yes line | head -n 2000",
			{ capture: { limits: { maxBytes: 100, maxLines: 5, retain: "tail" }, spill: true }, onUpdate: () => {} },
			BACKGROUND_CONTEXT,
		);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "unknown", message: expect.stringContaining("Failed to preserve complete shell output") },
		});
	});

	it("expands home-relative paths and file URLs", async () => {
		const sandbox = await sharedSandbox();
		const env = new OpenSandboxExecutionEnv({ provider: sandbox, cwd: "/workspace", homeDirectory: "/root" });
		expect(getOrThrow(await env.absolutePath("~/notes", BACKGROUND_CONTEXT))).toBe("/root/notes");
		expect(getOrThrow(await env.absolutePath("file:///workspace/a%20b.txt", BACKGROUND_CONTEXT))).toBe(
			"/workspace/a b.txt",
		);
		expect(getOrThrow(await env.absolutePath("../etc/hosts", BACKGROUND_CONTEXT))).toBe("/etc/hosts");
	});
});
