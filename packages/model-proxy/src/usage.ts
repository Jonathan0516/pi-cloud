/** Token counts recovered from a provider response, when the format is recognized. */
export interface UsageCounts {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fromAnthropicUsage(usage: unknown): UsageCounts | undefined {
	if (usage === null || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const counts: UsageCounts = {
		inputTokens: num(record.input_tokens),
		outputTokens: num(record.output_tokens),
		cacheReadTokens: num(record.cache_read_input_tokens),
		cacheWriteTokens: num(record.cache_creation_input_tokens),
	};
	return Object.values(counts).some((value) => value !== undefined) ? counts : undefined;
}

function fromOpenAiUsage(usage: unknown): UsageCounts | undefined {
	if (usage === null || typeof usage !== "object") return undefined;
	const record = usage as Record<string, unknown>;
	const promptDetails = (record.prompt_tokens_details ?? record.input_tokens_details) as
		| Record<string, unknown>
		| undefined;
	const counts: UsageCounts = {
		inputTokens: num(record.prompt_tokens) ?? num(record.input_tokens),
		outputTokens: num(record.completion_tokens) ?? num(record.output_tokens),
		cacheReadTokens: num(promptDetails?.cached_tokens),
	};
	return Object.values(counts).some((value) => value !== undefined) ? counts : undefined;
}

function merge(into: UsageCounts, from: UsageCounts | undefined): UsageCounts {
	if (!from) return into;
	return {
		inputTokens: from.inputTokens ?? into.inputTokens,
		outputTokens: from.outputTokens ?? into.outputTokens,
		cacheReadTokens: from.cacheReadTokens ?? into.cacheReadTokens,
		cacheWriteTokens: from.cacheWriteTokens ?? into.cacheWriteTokens,
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** `data:` payloads of a server-sent-event stream. */
export function sseDataPayloads(text: string): string[] {
	const payloads: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (data.length > 0 && data !== "[DONE]") payloads.push(data);
	}
	return payloads;
}

/**
 * Best-effort usage extraction for Anthropic Messages and OpenAI chat/responses bodies, in JSON or
 * SSE form. Unknown formats yield undefined; the billing row still records bytes and duration.
 */
export function extractUsage(api: string, contentType: string | undefined, body: string): UsageCounts | undefined {
	const anthropic = api.startsWith("anthropic");
	const isSse = contentType?.includes("text/event-stream") ?? false;
	if (!isSse) {
		const parsed = parseJson(body) as Record<string, unknown> | undefined;
		if (!parsed || typeof parsed !== "object") return undefined;
		return anthropic ? fromAnthropicUsage(parsed.usage) : fromOpenAiUsage(parsed.usage);
	}
	let counts: UsageCounts = {};
	let seen = false;
	for (const payload of sseDataPayloads(body)) {
		const event = parseJson(payload) as Record<string, unknown> | undefined;
		if (!event || typeof event !== "object") continue;
		let found: UsageCounts | undefined;
		if (anthropic) {
			const message = event.message as Record<string, unknown> | undefined;
			found = fromAnthropicUsage(message?.usage) ?? fromAnthropicUsage(event.usage);
		} else {
			const response = event.response as Record<string, unknown> | undefined;
			found = fromOpenAiUsage(event.usage) ?? fromOpenAiUsage(response?.usage);
		}
		if (found) {
			counts = merge(counts, found);
			seen = true;
		}
	}
	return seen ? counts : undefined;
}
