import { randomUUID } from "node:crypto";
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { ExecutionEnvFixture } from "@earendil-works/pi-agent-core/harness/env/testing";
import { afterAll, describe } from "vitest";
import { OpenSandboxExecutionEnv } from "../src/index.ts";

export const SANDBOX_DOMAIN = process.env.OPEN_SANDBOX_DOMAIN;
export const SANDBOX_API_KEY = process.env.OPEN_SANDBOX_API_KEY;
export const SANDBOX_IMAGE = process.env.PI_TEST_SANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0";
export const SANDBOX_TIMEOUT_SECONDS = 1800;

/** `describe` when an OpenSandbox server is configured, otherwise `describe.skip`. */
export const describeSandbox = SANDBOX_DOMAIN === undefined ? describe.skip : describe;

export function connectionConfig(): ConnectionConfig {
	if (SANDBOX_DOMAIN === undefined) throw new Error("OPEN_SANDBOX_DOMAIN is not set");
	return new ConnectionConfig({
		domain: SANDBOX_DOMAIN,
		...(SANDBOX_API_KEY === undefined ? {} : { apiKey: SANDBOX_API_KEY }),
		useServerProxy: true,
		requestTimeoutSeconds: 120,
	});
}

export function createSpec() {
	return {
		image: SANDBOX_IMAGE,
		timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
		readyTimeoutSeconds: 180,
		metadata: { purpose: "pi-env-opensandbox-test" },
	};
}

let shared: Promise<Sandbox> | undefined;

/** One sandbox per test file; killed after the file's tests finish. */
export function sharedSandbox(): Promise<Sandbox> {
	shared ??= Sandbox.create({ connectionConfig: connectionConfig(), ...createSpec() });
	return shared;
}

afterAll(async () => {
	if (shared === undefined) return;
	const pending = shared;
	shared = undefined;
	const sandbox = await pending.catch(() => undefined);
	if (sandbox === undefined) return;
	await sandbox.kill().catch(() => undefined);
	await sandbox.close().catch(() => undefined);
});

/** A fresh working directory inside the shared sandbox, wrapped in an environment that does not own it. */
export async function createSandboxFixture(): Promise<ExecutionEnvFixture> {
	const sandbox = await sharedSandbox();
	const cwd = `/workspace/env-conformance/${randomUUID()}`;
	await sandbox.files.createDirectories([{ path: cwd, mode: 755 }]);
	const env = new OpenSandboxExecutionEnv({ provider: sandbox, cwd, ownsProvider: false });
	return {
		env,
		async [Symbol.asyncDispose]() {
			await env.cleanup(BACKGROUND_CONTEXT);
			await sandbox.files.deleteDirectories([cwd]).catch(() => undefined);
		},
	};
}
