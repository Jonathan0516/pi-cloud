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
			{ find: /^@earendil-works\/pi-ai\/providers\/all$/, replacement: src("../ai/src/providers/all.ts") },
			{ find: /^@earendil-works\/pi-ai$/, replacement: src("../ai/src/index.ts") },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: src("../agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-session-backend-postgres$/, replacement: src("../session-backends/postgres/src/index.ts") },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
