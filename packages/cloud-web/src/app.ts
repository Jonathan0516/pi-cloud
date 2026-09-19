/**
 * The web presentation: a browser page that speaks to the gateway exactly as the local TUI speaks
 * to its server. Session listing and creation go over REST; the attached session goes over the
 * WebSocket and is folded by the same reducer the TUI uses, so the page has no agent state of its
 * own. Vanilla DOM on purpose: the whole client is small enough to read in one sitting.
 */

import { webSocketTransport } from "@earendil-works/pi-cloud-gateway/ws";
import { type AttachedSession, connect } from "@earendil-works/pi-coding-agent/experimental/mini/tui/session";
import { ApiError, GatewayApi, type Principal, type SessionView } from "./api.ts";
import { buildViewModel, summarizeArgs, type TranscriptBlock, type ViewModel } from "./view-model.ts";

const WORKSPACE_CWD = "/workspace";
const KEY_STORAGE = "pi-cloud.apiKey";
const BASE_STORAGE = "pi-cloud.baseUrl";

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | boolean | undefined> = {},
	...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (value === undefined || value === false) continue;
		if (name === "class") node.className = String(value);
		else if (value === true) node.setAttribute(name, "");
		else node.setAttribute(name, value);
	}
	for (const child of children) {
		if (child === null || child === undefined) continue;
		node.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

function shortId(id: string): string {
	return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

class App {
	readonly #root: HTMLElement;
	#api: GatewayApi | undefined;
	#principal: Principal | undefined;
	#sessions: SessionView[] = [];
	#attached: AttachedSession | undefined;
	#attachedId: string | undefined;
	#unsubscribe: (() => void) | undefined;
	#error: string | undefined;
	#connecting = false;
	// Rendered transcript nodes by block id, so streaming updates touch one node instead of all.
	#blockNodes = new Map<string, HTMLElement>();
	#transcriptEl: HTMLElement | undefined;
	#statusEl: HTMLElement | undefined;
	#sessionsEl: HTMLElement | undefined;

	constructor(root: HTMLElement) {
		this.#root = root;
	}

	async start(): Promise<void> {
		const key = sessionStorage.getItem(KEY_STORAGE);
		const base = sessionStorage.getItem(BASE_STORAGE) ?? location.origin;
		if (key) await this.#login(base, key);
		else this.#renderLogin();
	}

	async #login(baseUrl: string, apiKey: string): Promise<void> {
		const api = new GatewayApi(baseUrl, apiKey);
		try {
			this.#principal = await api.me();
		} catch (error) {
			sessionStorage.removeItem(KEY_STORAGE);
			this.#error =
				error instanceof ApiError && error.status === 401 ? "That key was not accepted." : describe(error);
			this.#renderLogin();
			return;
		}
		this.#api = api;
		this.#error = undefined;
		sessionStorage.setItem(KEY_STORAGE, apiKey);
		sessionStorage.setItem(BASE_STORAGE, baseUrl);
		this.#renderShell();
		await this.#refreshSessions();
	}

	#logout(): void {
		this.#detach();
		sessionStorage.removeItem(KEY_STORAGE);
		this.#api = undefined;
		this.#principal = undefined;
		this.#sessions = [];
		this.#renderLogin();
	}

	#renderLogin(): void {
		const base = el("input", {
			type: "url",
			value: sessionStorage.getItem(BASE_STORAGE) ?? location.origin,
			placeholder: "https://gateway.example.com",
			"aria-label": "Gateway URL",
		});
		const key = el("input", { type: "password", placeholder: "pik_…", "aria-label": "API key", autocomplete: "off" });
		const submit = el("button", { class: "primary", type: "submit" }, "Connect");
		const form = el(
			"form",
			{ class: "login" },
			el("h1", {}, "pi cloud"),
			el("label", {}, "Gateway", base),
			el("label", {}, "API key", key),
			this.#error ? el("div", { class: "error" }, this.#error) : null,
			el(
				"div",
				{ class: "hint" },
				"The key stays in this tab's session storage and is sent only to the gateway above.",
			),
			submit,
		);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			submit.disabled = true;
			void this.#login(base.value.trim(), key.value.trim()).finally(() => {
				submit.disabled = false;
			});
		});
		this.#root.replaceChildren(form);
		key.focus();
	}

	#renderShell(): void {
		const who = el("span", { class: "who" }, `${this.#principal?.tenant} / ${this.#principal?.user}`);
		const newButton = el("button", { class: "primary", type: "button" }, "New");
		newButton.addEventListener("click", () => void this.#createSession());
		const logout = el("button", { type: "button", title: "Forget the key" }, "Sign out");
		logout.addEventListener("click", () => this.#logout());
		this.#sessionsEl = el("ul", { class: "sessions" });
		const sidebar = el(
			"aside",
			{ class: "sidebar" },
			el("header", {}, who, el("span", {}, newButton, " ", logout)),
			this.#sessionsEl,
		);
		this.#statusEl = el("div", { class: "statusbar" }, el("span", {}, "Pick a session or create one."));
		this.#transcriptEl = el("div", { class: "transcript" }, el("div", { class: "empty" }, "No session attached."));
		this.#root.replaceChildren(
			el(
				"div",
				{ class: "shell" },
				sidebar,
				el("main", { class: "main" }, this.#statusEl, this.#transcriptEl, this.#composer()),
			),
		);
	}

	#composer(): HTMLElement {
		const input = el("textarea", { placeholder: "Ask the agent… (Enter to send, Shift+Enter for a newline)" });
		const send = el("button", { class: "primary", type: "button" }, "Send");
		const steer = el("button", { type: "button", title: "Interject into the running turn" }, "Steer");
		const followUp = el("button", { type: "button", title: "Queue for after this run" }, "Follow-up");
		const abort = el("button", { type: "button" }, "Abort");
		const note = el("span", { class: "note" });
		const submit = async (mode: "prompt" | "steer" | "followUp"): Promise<void> => {
			const text = input.value.trim();
			if (!text || !this.#attached) return;
			input.value = "";
			const result = await this.#attached.lane[mode](text).catch((error: unknown) => ({
				ok: false as const,
				error: describe(error),
			}));
			note.textContent = result.ok ? "" : `${mode} failed: ${result.error}`;
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				void submit(this.#attached?.state().lane.operation ? "followUp" : "prompt");
			}
		});
		send.addEventListener("click", () => void submit("prompt"));
		steer.addEventListener("click", () => void submit("steer"));
		followUp.addEventListener("click", () => void submit("followUp"));
		abort.addEventListener("click", () => void this.#attached?.lane.abort());
		return el(
			"div",
			{ class: "composer" },
			input,
			el("div", { class: "row" }, send, steer, followUp, abort, el("span", { class: "spacer" }), note),
		);
	}

	async #refreshSessions(): Promise<void> {
		if (!this.#api) return;
		try {
			this.#sessions = await this.#api.listSessions();
		} catch (error) {
			this.#setStatus(el("span", { class: "faulted" }, describe(error)));
			return;
		}
		this.#renderSessions();
	}

	#renderSessions(): void {
		if (!this.#sessionsEl) return;
		this.#sessionsEl.replaceChildren(
			...this.#sessions.map((session) => {
				const item = el(
					"li",
					{ class: session.id === this.#attachedId ? "active" : undefined, title: session.id },
					el("span", { class: "title" }, session.title ?? shortId(session.id)),
					el(
						"span",
						{ class: "meta" },
						el("span", { class: `dot ${session.state}` }),
						session.state,
						session.owner ? `· ${session.owner.node}` : "",
						`· ${new Date(session.createdAt).toLocaleString()}`,
					),
				);
				item.addEventListener("click", () => void this.#attach(session.id));
				return item;
			}),
		);
	}

	async #createSession(): Promise<void> {
		if (!this.#api) return;
		const title = prompt("Session title (optional)") ?? undefined;
		try {
			const created = await this.#api.createSession(title?.trim() || undefined);
			this.#sessions = [created, ...this.#sessions];
			this.#renderSessions();
			await this.#attach(created.id);
		} catch (error) {
			this.#setStatus(el("span", { class: "faulted" }, describe(error)));
		}
	}

	#detach(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#attached?.close();
		this.#attached = undefined;
		this.#attachedId = undefined;
		this.#blockNodes.clear();
	}

	async #attach(sessionId: string): Promise<void> {
		if (!this.#api || this.#connecting) return;
		this.#connecting = true;
		this.#detach();
		this.#attachedId = sessionId;
		this.#renderSessions();
		this.#setStatus(el("span", { class: "busy" }, `Attaching to ${shortId(sessionId)}…`));
		this.#transcriptEl?.replaceChildren();
		try {
			const attached = await connect(
				webSocketTransport(this.#api.webSocketUrl, this.#api.apiKey),
				sessionId,
				WORKSPACE_CWD,
			);
			this.#attached = attached;
			this.#unsubscribe = attached.subscribe(() => this.#render());
			this.#render();
			void this.#refreshSessions();
		} catch (error) {
			this.#attachedId = undefined;
			this.#setStatus(el("span", { class: "faulted" }, `Attach failed: ${describe(error)}`));
		} finally {
			this.#connecting = false;
		}
	}

	#setStatus(...children: Array<Node | string | null | undefined>): void {
		this.#statusEl?.replaceChildren(
			...children.filter((child): child is Node | string => child !== null && child !== undefined),
		);
	}

	#render(): void {
		if (!this.#attached || !this.#transcriptEl) return;
		const model = buildViewModel(this.#attached.state());
		this.#renderStatus(model);
		this.#renderTranscript(model.blocks);
	}

	#renderStatus(model: ViewModel): void {
		this.#setStatus(
			el("span", {}, `session ${shortId(this.#attachedId ?? "")}`),
			el("span", {}, model.model),
			el("span", {}, `thinking: ${model.thinkingLevel}`),
			el("span", {}, `${model.messageCount} messages · ${model.totalTokens} tokens · $${model.cost.toFixed(4)}`),
			model.queued > 0 ? el("span", {}, `${model.queued} queued`) : null,
			model.busy ? el("span", { class: "busy" }, model.operation ?? "working") : el("span", {}, "idle"),
			model.lastResult && !model.busy
				? el(
						"span",
						{ class: model.lastResult.status === "completed" ? "" : "faulted" },
						`last run: ${model.lastResult.status}${model.lastResult.error ? ` (${model.lastResult.error})` : ""}`,
					)
				: null,
			model.faulted ? el("span", { class: "faulted" }, "FAULTED") : null,
		);
	}

	#renderTranscript(blocks: TranscriptBlock[]): void {
		const container = this.#transcriptEl!;
		const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
		const seen = new Set<string>();
		const nodes: HTMLElement[] = [];
		for (const block of blocks) {
			seen.add(block.id);
			const existing = this.#blockNodes.get(block.id);
			const node = renderBlock(block, existing);
			this.#blockNodes.set(block.id, node);
			nodes.push(node);
		}
		for (const id of [...this.#blockNodes.keys()]) if (!seen.has(id)) this.#blockNodes.delete(id);
		if (nodes.length === 0) nodes.push(el("div", { class: "empty" }, "Say something to start."));
		container.replaceChildren(...nodes);
		if (nearBottom) container.scrollTop = container.scrollHeight;
	}
}

/** Build or refresh the DOM for one block. Tool details keep their open/closed state across refreshes. */
function renderBlock(block: TranscriptBlock, existing: HTMLElement | undefined): HTMLElement {
	switch (block.kind) {
		case "user":
			return (
				existing ??
				el("div", { class: "block user", title: formatTime(block.timestamp) }, el("pre", {}, block.text))
			);
		case "compaction":
			return (
				existing ?? el("div", { class: "block compaction" }, `Context compacted: ${block.summary.slice(0, 200)}`)
			);
		case "custom":
			return existing ?? el("div", { class: "block custom" }, `custom entry: ${block.customType}`);
		case "assistant": {
			const node = existing ?? el("div", { class: "block assistant" });
			node.className = "block assistant";
			const openTools = new Set(
				[...node.querySelectorAll("details.tool[open]")].map((details) => details.getAttribute("data-call") ?? ""),
			);
			const thinkingOpen = node.querySelector("details.thinking")?.hasAttribute("open") ?? false;
			const children: HTMLElement[] = [];
			if (block.thinking) {
				children.push(
					el(
						"details",
						{ class: "thinking", open: thinkingOpen },
						el("summary", {}, "thinking"),
						el("div", { class: "body" }, el("pre", {}, block.thinking)),
					),
				);
			}
			if (block.text) children.push(el("div", { class: `text${block.streaming ? " streaming" : ""}` }, block.text));
			for (const call of block.toolCalls) {
				const state = call.running ? "running" : call.result ? (call.result.isError ? "error" : "done") : "pending";
				children.push(
					el(
						"details",
						{ class: `tool ${state}`, "data-call": call.id, open: openTools.has(call.id) },
						el("summary", {}, el("strong", {}, call.name), el("code", {}, summarizeArgs(call.args))),
						el(
							"div",
							{ class: "body" },
							el("div", { class: "label" }, "arguments"),
							el("pre", {}, typeof call.args === "string" ? call.args : JSON.stringify(call.args, null, 2)),
							call.result ? el("div", { class: "label" }, call.result.isError ? "error" : "result") : null,
							call.result ? el("pre", {}, call.result.text) : null,
						),
					),
				);
			}
			if (block.model && !block.streaming)
				children.push(el("div", { class: "note" }, `${block.model} · ${formatTime(block.timestamp)}`));
			node.replaceChildren(...children);
			return node;
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const root = document.getElementById("app");
if (root) void new App(root).start();
