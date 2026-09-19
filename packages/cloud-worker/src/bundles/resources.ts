/**
 * Turn a cached bundle into what the harness consumes: skills and prompt templates as resources,
 * and the pieces of the system prompt. Skill locations are rewritten to where the bundle is mounted
 * inside the sandbox, because that is where the model's `read` tool runs.
 */

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { PromptTemplate, Skill } from "@earendil-works/pi-agent-core";
import { BUNDLE_MOUNT_PATH, type BundleManifest } from "./manifest.ts";

export interface BundleResources {
	version: string;
	systemPrompt: string | undefined;
	appendSystemPrompt: string[];
	agentsFile: string | undefined;
	skills: Skill[];
	promptTemplates: PromptTemplate[];
	/** Paths the bundle carries that this worker deliberately ignores (extensions). */
	ignored: string[];
	diagnostics: string[];
}

interface Frontmatter {
	attributes: Record<string, string>;
	body: string;
}

/** `key: value` lines between `---` fences. Enough for skills and prompt templates; not full YAML. */
export function parseFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) return { attributes: {}, body: text };
	const attributes: Record<string, string> = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		let value = pair[2]!.trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		attributes[pair[1]!] = value;
	}
	return { attributes, body: match[2] ?? "" };
}

export async function loadBundleResources(
	dir: string,
	version: string,
	manifest: BundleManifest,
	mountPath = BUNDLE_MOUNT_PATH,
): Promise<BundleResources> {
	const resources: BundleResources = {
		version,
		systemPrompt: undefined,
		appendSystemPrompt: [],
		agentsFile: undefined,
		skills: [],
		promptTemplates: [],
		ignored: [],
		diagnostics: [],
	};
	const read = (path: string): Promise<string> => readFile(join(dir, path), "utf8");
	const appends: Array<{ path: string; text: string }> = [];
	for (const entry of manifest.files) {
		const path = entry.path;
		const segments = path.split("/");
		if (path === "SYSTEM.md") resources.systemPrompt = (await read(path)).trim();
		else if (path === "AGENTS.md") resources.agentsFile = (await read(path)).trim();
		else if (
			path === "APPEND_SYSTEM.md" ||
			(segments[0] === "append" && segments.length === 2 && path.endsWith(".md"))
		) {
			appends.push({ path, text: (await read(path)).trim() });
		} else if (segments[0] === "skills" && segments.length === 3 && segments[2] === "SKILL.md") {
			const { attributes, body } = parseFrontmatter(await read(path));
			const name = attributes.name || segments[1]!;
			if (!attributes.description) {
				resources.diagnostics.push(`${path}: skill has no description; skipped`);
				continue;
			}
			resources.skills.push({
				name,
				description: attributes.description,
				content: body.trim(),
				filePath: posix.join(mountPath, path),
				...(attributes["disable-model-invocation"] === "true" ? { disableModelInvocation: true } : {}),
			});
		} else if (segments[0] === "prompts" && segments.length === 2 && path.endsWith(".md")) {
			const { attributes, body } = parseFrontmatter(await read(path));
			resources.promptTemplates.push({
				name: segments[1]!.slice(0, -".md".length),
				...(attributes.description ? { description: attributes.description } : {}),
				content: body.trim(),
			});
		} else if (segments[0] === "extensions") {
			resources.ignored.push(path);
		}
	}
	appends.sort((left, right) => (left.path < right.path ? -1 : 1));
	resources.appendSystemPrompt = appends.map((append) => append.text).filter((text) => text.length > 0);
	if (resources.ignored.length > 0) {
		resources.diagnostics.push(
			`${resources.ignored.length} extension file(s) ignored: tenant code does not run inside a cloud worker`,
		);
	}
	resources.skills.sort((left, right) => left.name.localeCompare(right.name));
	resources.promptTemplates.sort((left, right) => left.name.localeCompare(right.name));
	return resources;
}
