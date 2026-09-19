#!/usr/bin/env node
/**
 * Bundle the web client into dist/: app.js (+ map), index.html, styles.css.
 *   node packages/cloud-web/build.mjs [--out <dir>] [--watch]
 * The one Node import reachable from the mini presentation code (`node:crypto`) is aliased to a
 * browser shim; anything else Node-only is a build error, which is the point.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export function buildOptions(outdir) {
	return {
		entryPoints: [join(here, "src", "app.ts")],
		outdir,
		bundle: true,
		format: "esm",
		platform: "browser",
		target: ["es2022"],
		sourcemap: true,
		minify: false,
		tsconfig: join(repoRoot, "tsconfig.json"),
		conditions: ["source"],
		alias: { "node:crypto": join(here, "src", "shims", "node-crypto.ts") },
		logLevel: "warning",
	};
}

export function copyStatic(outdir) {
	mkdirSync(outdir, { recursive: true });
	copyFileSync(join(here, "index.html"), join(outdir, "index.html"));
	copyFileSync(join(here, "src", "styles.css"), join(outdir, "styles.css"));
}

export async function buildWeb(outdir = join(here, "dist")) {
	copyStatic(outdir);
	await build(buildOptions(outdir));
	return outdir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf("--out");
	const outdir = outIndex === -1 ? join(here, "dist") : resolve(args[outIndex + 1]);
	if (args.includes("--watch")) {
		copyStatic(outdir);
		const ctx = await context(buildOptions(outdir));
		await ctx.watch();
		console.error(`watching; writing to ${outdir}`);
	} else {
		await buildWeb(outdir);
		console.error(`built ${outdir}`);
	}
}
