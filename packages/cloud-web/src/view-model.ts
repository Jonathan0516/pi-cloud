/**
 * Pure projection of a session snapshot into what the page draws. No DOM here, so the shape of a
 * transcript (tool results folded under their calls, the streaming message at the tail, running
 * tools marked) is tested without a browser.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Entry } from "@earendil-works/pi-agent-core/harness/session";
import type { SessionSnapshot } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";

export interface ToolCallBlock {
	id: string;
	name: string;
	args: unknown;
	running: boolean;
	result?: { text: string; isError: boolean };
}

export type TranscriptBlock =
	| { kind: "user"; id: string; text: string; timestamp: number }
	| {
			kind: "assistant";
			id: string;
			text: string;
			thinking: string;
			toolCalls: ToolCallBlock[];
			streaming: boolean;
			model?: string;
			timestamp: number;
	  }
	| { kind: "compaction"; id: string; summary: string }
	| { kind: "custom"; id: string; customType: string };

export interface ViewModel {
	blocks: TranscriptBlock[];
	busy: boolean;
	/** Human-readable operation state, or null when idle. */
	operation: string | null;
	model: string;
	thinkingLevel: string;
	messageCount: number;
	totalTokens: number;
	cost: number;
	queued: number;
	faulted: boolean;
	lastResult?: { status: string; error?: string };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function assistantBlock(id: string, message: AgentMessage, streaming: boolean, timestamp: number): TranscriptBlock {
	const raw = (message as { content?: unknown }).content;
	const content = Array.isArray(raw) ? raw : [];
	const toolCalls: ToolCallBlock[] = [];
	let text = "";
	let thinking = "";
	for (const part of content as Array<Record<string, unknown>>) {
		if (part.type === "text" && typeof part.text === "string") text += part.text;
		else if (part.type === "thinking" && typeof part.thinking === "string") thinking += part.thinking;
		else if (part.type === "toolCall" && typeof part.id === "string") {
			toolCalls.push({ id: part.id, name: String(part.name ?? "tool"), args: part.arguments, running: false });
		}
	}
	const model = "model" in message && typeof message.model === "string" ? message.model : undefined;
	return { kind: "assistant", id, text, thinking, toolCalls, streaming, timestamp, ...(model ? { model } : {}) };
}

export function buildViewModel(snapshot: SessionSnapshot): ViewModel {
	const lane = snapshot.lane;
	const blocks: TranscriptBlock[] = [];
	const toolCallsById = new Map<string, ToolCallBlock>();
	const index = (block: TranscriptBlock): void => {
		if (block.kind === "assistant") for (const call of block.toolCalls) toolCallsById.set(call.id, call);
		blocks.push(block);
	};
	for (const entry of lane.transcript as Entry[]) {
		if (entry.type === "message") {
			const message = entry.message as AgentMessage & { role: string };
			if (message.role === "user") {
				index({ kind: "user", id: entry.id, text: textOf(message.content), timestamp: entry.timestamp });
			} else if (message.role === "assistant") {
				index(assistantBlock(entry.id, message, false, entry.timestamp));
			} else if (message.role === "toolResult") {
				const result = message as { toolCallId: string; content: unknown; isError?: boolean };
				const call = toolCallsById.get(result.toolCallId);
				if (call) call.result = { text: textOf(result.content), isError: result.isError === true };
			}
		} else if (entry.type === "compaction") {
			index({ kind: "compaction", id: entry.id, summary: entry.summary });
		} else if (entry.type === "custom") {
			index({ kind: "custom", id: entry.id, customType: entry.customType ?? "custom" });
		}
	}
	const operation = lane.operation;
	if (operation?.streamingMessage) {
		index(assistantBlock(`streaming:${operation.id}`, operation.streamingMessage, true, operation.startedAt));
	}
	if (operation) {
		for (const tool of operation.runningTools as Array<{ toolCallId: string; toolName: string; args?: unknown }>) {
			const call = toolCallsById.get(tool.toolCallId);
			if (call) {
				call.running = true;
				continue;
			}
			// A tool still running whose call is not in the streaming message: show it on its own.
			const running: ToolCallBlock = { id: tool.toolCallId, name: tool.toolName, args: tool.args, running: true };
			toolCallsById.set(running.id, running);
			const tail = blocks.at(-1);
			if (tail?.kind === "assistant" && tail.streaming) tail.toolCalls.push(running);
			else {
				index({
					kind: "assistant",
					id: `running:${tool.toolCallId}`,
					text: "",
					thinking: "",
					toolCalls: [running],
					streaming: true,
					timestamp: operation.startedAt,
				});
			}
		}
	}
	const usage = lane.stats.usage as { totalTokens?: number; cost?: { total?: number } };
	return {
		blocks,
		busy: operation !== null,
		operation:
			operation === null
				? null
				: `${operation.kind} ${operation.status}${operation.retry ? ` (retry ${operation.retry.attempt}/${operation.retry.maxAttempts})` : ""}`,
		model: `${lane.configuration.model.provider}/${lane.configuration.model.modelId}`,
		thinkingLevel: String(lane.configuration.thinkingLevel),
		messageCount: lane.stats.messageCount,
		totalTokens: usage.totalTokens ?? 0,
		cost: usage.cost?.total ?? 0,
		queued: lane.queues.length,
		faulted: lane.faulted,
		...(lane.lastResult
			? {
					lastResult: {
						status: lane.lastResult.status,
						...(lane.lastResult.error ? { error: describeError(lane.lastResult.error) } : {}),
					},
				}
			: {}),
	};
}

function describeError(error: unknown): string {
	if (typeof error === "string") return error;
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
		return error.message;
	return JSON.stringify(error);
}

/** Short one-line rendering of tool arguments for the collapsed header. */
export function summarizeArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	if (typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["command", "path", "file_path", "pattern", "query"]) {
			const value = record[key];
			if (typeof value === "string") return value;
		}
	}
	const json = JSON.stringify(args);
	return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}
