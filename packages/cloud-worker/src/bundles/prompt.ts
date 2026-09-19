/** System prompt composition for a cloud session: the bundle's pieces around the worker's default. */

import type { Skill } from "@earendil-works/pi-agent-core";
import type { BundleResources } from "./resources.ts";

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The agentskills.io listing the harness's own formatter produces; kept here so the worker needs no extra export. */
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Read the full skill file with the read tool when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/**
 * `SYSTEM.md` replaces the default prompt; `AGENTS.md`, the appends, and the skill listing follow
 * in that order, separated by blank lines. Without a bundle the default prompt stands alone.
 */
export function composeSystemPrompt(defaultPrompt: string, resources: BundleResources | undefined): string {
	if (resources === undefined) return defaultPrompt;
	const sections = [resources.systemPrompt ?? defaultPrompt];
	if (resources.agentsFile) sections.push(`# Project instructions\n\n${resources.agentsFile}`);
	sections.push(...resources.appendSystemPrompt);
	const skills = formatSkillsForSystemPrompt(resources.skills);
	if (skills) sections.push(skills);
	return sections.filter((section) => section.length > 0).join("\n\n");
}
