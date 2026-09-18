import { createModels, type Model, type Models } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { builtinUpstreams, createProxyCredentials, proxyModelBaseUrl, withModelProxy } from "../src/index.ts";

describe("worker-side proxy helpers", () => {
	it("derives upstreams for the built-in providers", () => {
		const upstreams = builtinUpstreams();
		expect(upstreams.get("anthropic")).toMatchObject({ authStyle: "x-api-key", api: "anthropic-messages" });
		expect(upstreams.get("deepseek")).toMatchObject({ authStyle: "bearer" });
		expect(upstreams.get("deepseek")?.baseUrl).toMatch(/^https:\/\//);
	});

	it("seeds one token credential per provider", async () => {
		const store = await createProxyCredentials("pimp1.x.y", ["deepseek", "anthropic"]);
		expect(await store.read("deepseek")).toEqual({ type: "api_key", key: "pimp1.x.y" });
		expect(await store.read("openai")).toBeUndefined();
	});

	it("rewrites every model it hands out and every model it is asked to call", async () => {
		const models: Models = createModels();
		for (const provider of builtinProviders()) {
			if (provider.id === "deepseek" || provider.id === "anthropic")
				(models as unknown as { registerProvider(p: unknown): void }).registerProvider?.(provider);
		}
		let called: Model<"openai-completions"> | undefined;
		const fake = {
			getModel: (provider: string, id: string) =>
				provider === "deepseek"
					? ({
							id,
							provider,
							api: "openai-completions",
							baseUrl: "https://api.deepseek.com",
						} as Model<"openai-completions">)
					: undefined,
			getModels: () => [
				{
					id: "a",
					provider: "deepseek",
					api: "openai-completions",
					baseUrl: "https://api.deepseek.com",
				} as Model<"openai-completions">,
			],
			getAvailable: async () => [
				{
					id: "b",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				} as Model<"anthropic-messages">,
			],
			streamSimple: (model: Model<"openai-completions">) => {
				called = model;
				return "stream";
			},
			getProviders: () => [],
		} as unknown as Models;
		const proxied = withModelProxy(fake, "http://127.0.0.1:9100/");
		expect(proxied.getModel("deepseek", "m")?.baseUrl).toBe("http://127.0.0.1:9100/v1/deepseek");
		expect(proxied.getModel("other", "m")).toBeUndefined();
		expect(proxied.getModels().map((model) => model.baseUrl)).toEqual(["http://127.0.0.1:9100/v1/deepseek"]);
		expect((await proxied.getAvailable()).map((model) => model.baseUrl)).toEqual([
			"http://127.0.0.1:9100/v1/anthropic",
		]);
		const original = fake.getModel("deepseek", "m") as Model<"openai-completions">;
		expect(
			(proxied as unknown as { streamSimple(model: Model<"openai-completions">): string }).streamSimple(original),
		).toBe("stream");
		expect(called?.baseUrl).toBe(proxyModelBaseUrl("http://127.0.0.1:9100", "deepseek"));
		expect(original.baseUrl).toBe("https://api.deepseek.com");
		expect(proxied.getProviders()).toEqual([]);
	});
});
