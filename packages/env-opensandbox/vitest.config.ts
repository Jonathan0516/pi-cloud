import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetryIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const agentIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentEnvTesting = fileURLToPath(new URL("../agent/src/harness/env/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 60_000,
		hookTimeout: 180_000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		coverage: {
			provider: "v8",
			all: true,
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage",
		},
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetryIndex },
			{ find: /^@earendil-works\/pi-agent-core\/harness\/env\/testing$/, replacement: agentEnvTesting },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentIndex },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
