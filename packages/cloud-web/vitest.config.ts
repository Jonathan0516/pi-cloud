import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 60_000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: src("../telemetry/src/index.ts") },
			{ find: /^@earendil-works\/pi-agent-core\/harness\/session$/, replacement: src("../agent/src/harness/session/index.ts") },
			{ find: /^@earendil-works\/pi-agent-core\/harness\/runtime\/reducer$/, replacement: src("../agent/src/harness/runtime/reducer.ts") },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: src("../agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-ai$/, replacement: src("../ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-cloud-gateway\/ws$/, replacement: src("../cloud-gateway/src/ws.ts") },
			{ find: /^@earendil-works\/pi-coding-agent\/(.*)$/, replacement: `${src("../coding-agent/src/")}$1` },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
