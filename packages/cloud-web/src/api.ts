/** The gateway's REST surface, as the page uses it. */

export interface SessionView {
	id: string;
	tenant: string;
	user: string;
	title: string | null;
	createdAt: number;
	path: string;
	cwd: string;
	state: "running" | "idle";
	owner: { node: string; addr: string } | null;
}

export interface Principal {
	tenant: string;
	user: string;
}

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class GatewayApi {
	readonly baseUrl: string;
	readonly apiKey: string;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
	}

	/** `ws(s)://host/v1/ws` for the same origin as the REST base. */
	get webSocketUrl(): string {
		return `${this.baseUrl.replace(/^http/, "ws")}/v1/ws`;
	}

	me(): Promise<Principal> {
		return this.request<Principal>("GET", "/v1/me");
	}

	async listSessions(): Promise<SessionView[]> {
		return (await this.request<{ sessions: SessionView[] }>("GET", "/v1/sessions")).sessions;
	}

	createSession(title?: string): Promise<SessionView> {
		return this.request<SessionView>("POST", "/v1/sessions", title ? { title } : {});
	}

	getSession(id: string): Promise<SessionView> {
		return this.request<SessionView>("GET", `/v1/sessions/${encodeURIComponent(id)}`);
	}

	async deleteSession(id: string): Promise<void> {
		await this.request<void>("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (response.status === 204) return undefined as T;
		const text = await response.text();
		let parsed: unknown;
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = { error: text };
			}
		}
		if (!response.ok) {
			const message =
				parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
					? parsed.error
					: `${response.status} ${response.statusText}`;
			throw new ApiError(response.status, message);
		}
		return parsed as T;
	}
}
