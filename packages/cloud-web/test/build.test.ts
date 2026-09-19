import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript build script
import { buildWeb } from "../build.mjs";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("browser bundle", () => {
	it("bundles the presentation without any Node built-in left in", async () => {
		const outdir = await mkdtemp(join(tmpdir(), "pi-cloud-web-"));
		dirs.push(outdir);
		await buildWeb(outdir);
		const files = await readdir(outdir);
		expect(files.sort()).toEqual(["app.js", "app.js.map", "index.html", "styles.css"]);
		const bundle = await readFile(join(outdir, "app.js"), "utf8");
		expect(bundle).not.toMatch(/from\s+["']node:/);
		expect(bundle).not.toMatch(/require\(["']node:/);
		expect(bundle).toContain("pi-cloud.v1");
		expect(bundle).toContain("reduceLaneSnapshot");
	});
});
