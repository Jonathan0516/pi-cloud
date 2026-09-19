import { verifyProxyToken } from "@earendil-works/pi-model-proxy";
import { describe, expect, it } from "vitest";
import type { CloudConfig } from "../src/config.ts";
import { loadWorkerNodeIdentity, workerNodeIdentityToEnv } from "../src/config.ts";
import { isVendorSecretVariable, workerEnvironment } from "../src/server/worker-env.ts";

const SECRET = "server-only-secret-0123456789";

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
	return {
		databaseUrl: "postgres://x",
		schema: "pi_cloud",
		sandboxDomain: "127.0.0.1:8080",
		sandboxImage: "img",
		sandboxTimeoutSeconds: 600,
		workspacesRoot: "/tmp/w",
		bundleCacheDir: "/tmp/w/.bundles",
		workspaceRetentionDays: 14,
		workspaceGcIntervalMs: 0,
		leaseTtlSeconds: 30,
		leaseHeartbeatMs: 5000,
		nodeId: "node-a",
		nodeListenHost: "127.0.0.1",
		nodeListenPort: 0,
		nodePersistent: false,
		reaperIntervalMs: 5000,
		reaperTakeoversPerTick: 2,
		poisonThreshold: 3,
		workerIdleGraceMs: 30_000,
		...overrides,
	};
}

describe("worker environment", () => {
	it("passes vendor variables through when no proxy is configured", () => {
		const env = workerEnvironment({ PATH: "/bin", DEEPSEEK_API_KEY: "sk-real" }, config(), "s1");
		expect(env.DEEPSEEK_API_KEY).toBe("sk-real");
		expect(env.PI_MODEL_PROXY_TOKEN).toBeUndefined();
		expect(env.PI_PG_SCHEMA).toBe("pi_cloud");
	});

	it("replaces every vendor credential with a session-bound token in proxy mode", () => {
		const env = workerEnvironment(
			{
				PATH: "/bin",
				DEEPSEEK_API_KEY: "sk-real",
				ANTHROPIC_AUTH_TOKEN: "tok",
				ANTHROPIC_BASE_URL: "https://elsewhere",
				AWS_SECRET_ACCESS_KEY: "aws",
				GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
				PI_MODEL_PROXY_SECRET: SECRET,
				HOME: "/home/x",
			},
			config({
				modelProxy: { url: "http://127.0.0.1:9100", secret: SECRET, providers: ["deepseek"], tokenTtlSeconds: 60 },
			}),
			"s1",
			{ TSX_TSCONFIG_PATH: "/repo/tsconfig.json" },
		);
		for (const name of [
			"DEEPSEEK_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"AWS_SECRET_ACCESS_KEY",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"PI_MODEL_PROXY_SECRET",
		]) {
			expect(env[name], name).toBeUndefined();
		}
		expect(env.PATH).toBe("/bin");
		expect(env.HOME).toBe("/home/x");
		expect(env.TSX_TSCONFIG_PATH).toBe("/repo/tsconfig.json");
		expect(env.PI_MODEL_PROXY_URL).toBe("http://127.0.0.1:9100");
		expect(env.PI_MODEL_PROXY_PROVIDERS).toBe("deepseek");
		expect(verifyProxyToken(SECRET, env.PI_MODEL_PROXY_TOKEN!)).toMatchObject({
			ok: true,
			claims: { tenant: "local", session: "s1" },
		});
	});

	it("classifies vendor secret variable names", () => {
		expect(isVendorSecretVariable("OPENAI_API_KEY")).toBe(true);
		expect(isVendorSecretVariable("ANTHROPIC_BASE_URL")).toBe(true);
		expect(isVendorSecretVariable("PI_MODEL_PROXY_SECRET")).toBe(true);
		expect(isVendorSecretVariable("PI_MODEL_PROXY_URL")).toBe(false);
		expect(isVendorSecretVariable("PI_MODEL_PROXY_TOKEN")).toBe(false);
		expect(isVendorSecretVariable("PATH")).toBe(false);
	});

	it("hands the worker the node identity its lease must record", () => {
		const env = workerEnvironment({ PATH: "/bin" }, config(), "s1", {
			...workerNodeIdentityToEnv({ node: "node-a", addr: "10.0.0.5:7420" }),
		});
		expect(loadWorkerNodeIdentity(env)).toEqual({ node: "node-a", addr: "10.0.0.5:7420" });
	});
});
