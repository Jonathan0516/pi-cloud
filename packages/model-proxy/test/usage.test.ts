import { describe, expect, it } from "vitest";
import { extractUsage } from "../src/index.ts";

describe("usage extraction", () => {
	it("reads Anthropic JSON and SSE usage", () => {
		expect(
			extractUsage(
				"anthropic-messages",
				"application/json",
				JSON.stringify({ usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 } }),
			),
		).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: undefined });
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1,"cache_creation_input_tokens":5}}}\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n',
			'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":17}}\n',
		].join("\n");
		expect(extractUsage("anthropic-messages", "text/event-stream", sse)).toEqual({
			inputTokens: 20,
			outputTokens: 17,
			cacheReadTokens: undefined,
			cacheWriteTokens: 5,
		});
	});

	it("reads OpenAI chat and responses usage", () => {
		expect(
			extractUsage(
				"openai-completions",
				"application/json",
				JSON.stringify({
					usage: { prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 6 } },
				}),
			),
		).toEqual({ inputTokens: 7, outputTokens: 2, cacheReadTokens: 6 });
		const sse =
			'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\ndata: [DONE]\n';
		expect(extractUsage("openai-completions", "text/event-stream; charset=utf-8", sse)).toEqual({
			inputTokens: 11,
			outputTokens: 3,
			cacheReadTokens: undefined,
		});
		const responses =
			'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":9,"input_tokens_details":{"cached_tokens":1}}}}\n';
		expect(extractUsage("openai-responses", "text/event-stream", responses)).toEqual({
			inputTokens: 5,
			outputTokens: 9,
			cacheReadTokens: 1,
		});
	});

	it("returns undefined for unknown bodies", () => {
		expect(extractUsage("openai-completions", "application/json", "not json")).toBeUndefined();
		expect(extractUsage("openai-completions", "text/event-stream", "data: {}\n")).toBeUndefined();
	});
});
