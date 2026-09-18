import { fileURLToPath } from "node:url";

const REPOSITORY_TSCONFIG = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));

/**
 * Node arguments that let a spawned entry run, whether the parent was started through the tsx
 * binary, through `node --import tsx`, or from compiled JavaScript.
 */
export function loaderArgsFor(entry: string): string[] {
	const args = [...process.execArgv];
	if (!entry.endsWith(".ts")) return args;
	if (args.some((arg) => arg.includes("tsx"))) return args;
	return [...args, "--import", "tsx"];
}

/**
 * Environment for a spawned TypeScript entry: tsx must apply the repository `paths`, which it
 * cannot find from an arbitrary working directory.
 */
export function loaderEnvFor(entry: string): Record<string, string> {
	return entry.endsWith(".ts") ? { TSX_TSCONFIG_PATH: REPOSITORY_TSCONFIG } : {};
}
