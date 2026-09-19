import type { SessionSnapshot } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import { describe, expect, it } from "vitest";
import { buildViewModel, summarizeArgs } from "../src/view-model.ts";

function snapshot(overrides: Partial<SessionSnapshot["lane"]> = {}): SessionSnapshot {
	return {
		sessionId: "s1",
		cwd: "/workspace",
		sessionPath: "postgres:pi_cloud/s1",
		models: {} as SessionSnapshot["models"],
		lane: {
			lane: "main",
			transcript: [],
			tipId: null,
			configuration: {
				model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
				thinkingLevel: "medium",
				activeToolNames: [],
			},
			stats: { messageCount: 0, usage: { totalTokens: 1234, cost: { total: 0.0021 } } as never },
			operation: null,
			queues: [],
			faulted: false,
			...overrides,
		} as SessionSnapshot["lane"],
	};
}

const user = (id: string, text: string) =>
	({
		id,
		parentId: null,
		seq: 1,
		timestamp: 1000,
		type: "message",
		message: { role: "user", content: text, timestamp: 1000 },
	}) as never;
const assistant = (id: string, content: unknown[]) =>
	({
		id,
		parentId: null,
		seq: 2,
		timestamp: 2000,
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "openai-completions",
			provider: "deepseek",
			model: "deepseek-v4-pro",
		},
	}) as never;
const toolResult = (id: string, toolCallId: string, text: string, isError = false) =>
	({
		id,
		parentId: null,
		seq: 3,
		timestamp: 3000,
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError },
	}) as never;

describe("view model", () => {
	it("folds tool results under their calls and reads text, thinking, and model", () => {
		const model = buildViewModel(
			snapshot({
				transcript: [
					user("u1", "list files"),
					assistant("a1", [
						{ type: "thinking", thinking: "let me look" },
						{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
					]),
					toolResult("t1", "c1", "a.txt\nb.txt"),
					assistant("a2", [{ type: "text", text: "Two files." }]),
				],
				lastResult: {
					operationId: "op1",
					kind: "run",
					status: "completed",
					fromTipId: null,
					tipId: "a2",
					startedAt: 1,
					endedAt: 2,
				},
			}),
		);
		expect(model.blocks.map((block) => block.kind)).toEqual(["user", "assistant", "assistant"]);
		expect(model.blocks[0]).toMatchObject({ kind: "user", text: "list files" });
		expect(model.blocks[1]).toMatchObject({
			kind: "assistant",
			thinking: "let me look",
			model: "deepseek-v4-pro",
			streaming: false,
			toolCalls: [
				{
					id: "c1",
					name: "bash",
					args: { command: "ls" },
					running: false,
					result: { text: "a.txt\nb.txt", isError: false },
				},
			],
		});
		expect(model.blocks[2]).toMatchObject({ kind: "assistant", text: "Two files." });
		expect(model).toMatchObject({
			busy: false,
			operation: null,
			model: "deepseek/deepseek-v4-pro",
			totalTokens: 1234,
			cost: 0.0021,
		});
		expect(model.lastResult).toEqual({ status: "completed" });
	});

	it("appends the streaming message and marks running tools", () => {
		const model = buildViewModel(
			snapshot({
				transcript: [user("u1", "go")],
				operation: {
					id: "op2",
					kind: "run",
					startedAt: 5000,
					fromTipId: null,
					status: "running",
					streamingMessage: {
						role: "assistant",
						content: [
							{ type: "text", text: "Running…" },
							{ type: "toolCall", id: "c9", name: "bash", arguments: { command: "sleep 5" } },
						],
					} as never,
					runningTools: [{ toolCallId: "c9", toolName: "bash", args: { command: "sleep 5" } }] as never,
				},
			}),
		);
		expect(model.busy).toBe(true);
		expect(model.operation).toBe("run running");
		const tail = model.blocks.at(-1);
		expect(tail).toMatchObject({
			kind: "assistant",
			streaming: true,
			text: "Running…",
			toolCalls: [{ id: "c9", running: true }],
		});
	});

	it("shows a running tool whose call has not streamed yet, and surfaces failures", () => {
		const model = buildViewModel(
			snapshot({
				transcript: [],
				operation: {
					id: "op3",
					kind: "run",
					startedAt: 5000,
					fromTipId: null,
					status: "aborting",
					runningTools: [{ toolCallId: "c10", toolName: "read", args: { path: "/workspace/a.txt" } }] as never,
				},
				lastResult: {
					operationId: "op0",
					kind: "run",
					status: "failed",
					error: { code: "boom", message: "provider exploded" } as never,
					fromTipId: null,
					tipId: null,
					startedAt: 1,
					endedAt: 2,
				},
				faulted: true,
			}),
		);
		expect(model.blocks).toEqual([
			expect.objectContaining({
				kind: "assistant",
				streaming: true,
				toolCalls: [expect.objectContaining({ id: "c10", name: "read", running: true })],
			}),
		]);
		expect(model.operation).toBe("run aborting");
		expect(model.faulted).toBe(true);
		expect(model.lastResult).toEqual({ status: "failed", error: "provider exploded" });
	});

	it("summarizes tool arguments to one line", () => {
		expect(summarizeArgs({ command: "ls -la" })).toBe("ls -la");
		expect(summarizeArgs({ path: "/x" })).toBe("/x");
		expect(summarizeArgs("raw")).toBe("raw");
		expect(summarizeArgs(undefined)).toBe("");
		expect(summarizeArgs({ big: "x".repeat(200) }).length).toBeLessThanOrEqual(120);
	});
});
