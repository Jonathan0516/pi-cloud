import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { materializeBundle, readCachedBundle } from "../src/bundles/cache.ts";
import {
	BUILTIN_ENTRY_TYPES,
	BundleValidationError,
	buildManifest,
	bundleVersion,
	canonicalJson,
	verifyBundleFiles,
} from "../src/bundles/manifest.ts";
import { loadBundleResources, parseFrontmatter } from "../src/bundles/resources.ts";
import { planBundleUpgrade } from "../src/bundles/upgrade.ts";

const text = (value: string) => new TextEncoder().encode(value);
const sampleFiles = () =>
	new Map([
		["SYSTEM.md", text("You are the acme agent.\n")],
		["AGENTS.md", text("Run tests before you finish.")],
		["append/10-style.md", text("Be terse.")],
		["append/00-safety.md", text("Never delete the repo.")],
		["skills/deploy/SKILL.md", text("---\nname: deploy\ndescription: Deploy the service\n---\nRun make deploy.\n")],
		["skills/deploy/checklist.md", text("- build\n- push\n")],
		["skills/nodesc/SKILL.md", text("---\nname: nodesc\n---\nno description\n")],
		[
			"prompts/review.md",
			text("---\ndescription: Review a file\nargument-hint: <path>\n---\nReview $1 carefully.\n"),
		],
		["extensions/hello.ts", text("export default () => {}")],
	]);

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("bundle manifest", () => {
	it("hashes the same files to the same version regardless of insertion order", () => {
		const a = buildManifest(sampleFiles());
		const b = buildManifest(new Map([...sampleFiles()].reverse()));
		expect(bundleVersion(a)).toBe(bundleVersion(b));
		expect(bundleVersion(a)).toMatch(/^[0-9a-f]{64}$/);
		expect(a.files.map((entry) => entry.path)).toEqual([...a.files.map((entry) => entry.path)].sort());
		expect(a.registers.entryTypes).toEqual([...BUILTIN_ENTRY_TYPES].sort());
	});

	it("changes the version when any byte changes", () => {
		const files = sampleFiles();
		const before = bundleVersion(buildManifest(files));
		files.set("SYSTEM.md", text("You are the acme agent!\n"));
		expect(bundleVersion(buildManifest(files))).not.toBe(before);
	});

	it("rejects unsafe paths and verifies files against the manifest", () => {
		expect(() => buildManifest(new Map([["../escape.md", text("x")]]))).toThrow(BundleValidationError);
		expect(() => buildManifest(new Map([["/abs.md", text("x")]]))).toThrow(BundleValidationError);
		expect(() => buildManifest(new Map())).toThrow(BundleValidationError);
		const files = sampleFiles();
		const manifest = buildManifest(files);
		verifyBundleFiles(manifest, files);
		const tampered = new Map(files);
		tampered.set("SYSTEM.md", text("changed"));
		expect(() => verifyBundleFiles(manifest, tampered)).toThrow(/does not match/);
		const extra = new Map(files);
		extra.set("rogue.md", text("x"));
		expect(() => verifyBundleFiles(manifest, extra)).toThrow(/not in manifest/);
	});

	it("canonicalizes JSON with sorted keys and no undefined", () => {
		expect(canonicalJson({ b: 1, a: [{ d: undefined, c: "x" }] })).toBe('{"a":[{"c":"x"}],"b":1}');
	});
});

describe("bundle cache", () => {
	it("materializes once, refuses tampered files, and reuses a complete directory", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "pi-bundles-"));
		dirs.push(cacheDir);
		const files = sampleFiles();
		const manifest = buildManifest(files);
		const version = bundleVersion(manifest);
		expect(await readCachedBundle(cacheDir, version)).toBeUndefined();

		const cached = await materializeBundle(cacheDir, version, manifest, files);
		expect(cached.dir).toBe(join(cacheDir, version));
		expect(await readFile(join(cached.dir, "skills/deploy/checklist.md"), "utf8")).toBe("- build\n- push\n");
		expect(await readCachedBundle(cacheDir, version)).toMatchObject({ version, dir: cached.dir });

		// Editing the cache does not change what a second materialize returns: complete directories are trusted.
		await writeFile(join(cached.dir, "SYSTEM.md"), "edited");
		expect((await materializeBundle(cacheDir, version, manifest, files)).dir).toBe(cached.dir);

		const tampered = new Map(files);
		tampered.set("AGENTS.md", text("evil"));
		await expect(materializeBundle(cacheDir, "f".repeat(64), manifest, tampered)).rejects.toThrow(
			BundleValidationError,
		);
		await expect(materializeBundle(cacheDir, "not-a-version", manifest, files)).rejects.toThrow(
			BundleValidationError,
		);
	});
});

describe("bundle resources", () => {
	it("parses frontmatter loosely", () => {
		expect(parseFrontmatter('---\nname: "x"\ndescription: does y\n---\nbody')).toEqual({
			attributes: { name: "x", description: "does y" },
			body: "body",
		});
		expect(parseFrontmatter("no frontmatter")).toEqual({ attributes: {}, body: "no frontmatter" });
	});

	it("loads skills, templates, and prompt pieces with sandbox-mounted skill paths", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "pi-bundles-"));
		dirs.push(cacheDir);
		const files = sampleFiles();
		const manifest = buildManifest(files);
		const version = bundleVersion(manifest);
		const cached = await materializeBundle(cacheDir, version, manifest, files);
		const resources = await loadBundleResources(cached.dir, version, manifest, "/opt/pi/bundle");
		expect(resources.systemPrompt).toBe("You are the acme agent.");
		expect(resources.agentsFile).toBe("Run tests before you finish.");
		expect(resources.appendSystemPrompt).toEqual(["Never delete the repo.", "Be terse."]);
		expect(resources.skills).toEqual([
			{
				name: "deploy",
				description: "Deploy the service",
				content: "Run make deploy.",
				filePath: "/opt/pi/bundle/skills/deploy/SKILL.md",
			},
		]);
		expect(resources.promptTemplates).toEqual([
			{ name: "review", description: "Review a file", content: "Review $1 carefully." },
		]);
		expect(resources.ignored).toEqual(["extensions/hello.ts"]);
		expect(resources.diagnostics.join("\n")).toMatch(/nodesc.*no description/);
		expect(resources.diagnostics.join("\n")).toMatch(/extension file/);
	});
});

describe("bundle upgrade rule", () => {
	const types = { entryTypes: ["message", "compaction"], customTypes: [] };
	const registers = { entryTypes: [...BUILTIN_ENTRY_TYPES], customTypes: [] };

	it("does nothing without a tenant default", () => {
		expect(
			planBundleUpgrade({
				pinned: undefined,
				tenantDefault: undefined,
				hasOpenOperation: false,
				sessionTypes: types,
				defaultRegisters: undefined,
			}),
		).toMatchObject({ action: "none" });
		expect(
			planBundleUpgrade({
				pinned: "a",
				tenantDefault: undefined,
				hasOpenOperation: false,
				sessionTypes: types,
				defaultRegisters: undefined,
			}),
		).toMatchObject({ action: "keep", version: "a" });
	});

	it("keeps the pin while an operation is open and upgrades at an idle boundary", () => {
		expect(
			planBundleUpgrade({
				pinned: "a",
				tenantDefault: "b",
				hasOpenOperation: true,
				sessionTypes: types,
				defaultRegisters: registers,
			}),
		).toMatchObject({ action: "keep", version: "a" });
		expect(
			planBundleUpgrade({
				pinned: "a",
				tenantDefault: "b",
				hasOpenOperation: false,
				sessionTypes: types,
				defaultRegisters: registers,
			}),
		).toMatchObject({ action: "upgrade", version: "b", from: "a" });
		expect(
			planBundleUpgrade({
				pinned: undefined,
				tenantDefault: "b",
				hasOpenOperation: false,
				sessionTypes: types,
				defaultRegisters: registers,
			}),
		).toMatchObject({ action: "adopt", version: "b" });
		expect(
			planBundleUpgrade({
				pinned: "b",
				tenantDefault: "b",
				hasOpenOperation: true,
				sessionTypes: types,
				defaultRegisters: registers,
			}),
		).toMatchObject({ action: "keep", version: "b" });
	});

	it("refuses a default that does not register a type the session already holds", () => {
		const skewed = { entryTypes: ["message", "compaction", "custom"], customTypes: ["pi.task"] };
		const plan = planBundleUpgrade({
			pinned: "a",
			tenantDefault: "b",
			hasOpenOperation: false,
			sessionTypes: skewed,
			defaultRegisters: registers,
		});
		expect(plan).toMatchObject({ action: "keep", version: "a" });
		expect(plan.reason).toMatch(/custom, custom:pi\.task/);
		const capable = { entryTypes: [...BUILTIN_ENTRY_TYPES, "custom"], customTypes: ["pi.task"] };
		expect(
			planBundleUpgrade({
				pinned: "a",
				tenantDefault: "b",
				hasOpenOperation: false,
				sessionTypes: skewed,
				defaultRegisters: capable,
			}),
		).toMatchObject({ action: "upgrade" });
	});
});
