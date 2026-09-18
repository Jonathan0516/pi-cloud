import {
	ConnectionConfig,
	type ConnectionConfigOptions,
	Sandbox,
	type SandboxCreateOptions,
} from "@alibaba-group/opensandbox";
import { type Context, ExecutionError, err, ok, type Result, toError } from "@earendil-works/pi-agent-core";

/** Supplies the sandbox behind an execution environment and decides when to re-provision it. */
export interface SandboxProvider {
	/** Resolve the sandbox for the next operation, creating or reconnecting as needed. */
	acquire(context: Context): Promise<Result<Sandbox, ExecutionError>>;
	/** Report that `sandbox` failed at the transport level so the next acquire re-provisions. */
	invalidate(sandbox: Sandbox, cause: unknown): void;
	/** Release everything the provider holds. Best-effort; never throws. */
	close(context: Context): Promise<void>;
}

/** Wraps a sandbox the caller already owns. Never provisions; `close` leaves the sandbox running. */
export class StaticSandboxProvider implements SandboxProvider {
	readonly #sandbox: Sandbox;

	constructor(sandbox: Sandbox) {
		this.#sandbox = sandbox;
	}

	async acquire(_context: Context): Promise<Result<Sandbox, ExecutionError>> {
		return ok(this.#sandbox);
	}

	invalidate(_sandbox: Sandbox, _cause: unknown): void {}

	async close(_context: Context): Promise<void> {}
}

export interface LazySandboxProviderOptions {
	connectionConfig: ConnectionConfig | ConnectionConfigOptions;
	/** Creation request used when no sandbox can be reconnected. */
	create: Omit<SandboxCreateOptions, "connectionConfig">;
	/** Reconnect to this sandbox first; fall back to creation when it is gone. */
	sandboxId?: string;
	/**
	 * Runs after every successful create or connect, before the sandbox is handed out. Inject
	 * credentials, clone repositories, verify tooling. A rejection fails the acquire.
	 */
	onProvisioned?: (sandbox: Sandbox, event: { reason: "created" | "connected" }, context: Context) => Promise<void>;
	/** Extend the sandbox TTL on use so a long turn outlives the creation timeout. */
	keepAlive?: { timeoutSeconds: number; minIntervalMs?: number };
	/** Kill the sandbox when the provider closes. Defaults to false: the host decides when to reap. */
	killOnClose?: boolean;
}

/**
 * Provisions the sandbox on first use. Session creation stays cheap because no container exists
 * until the first tool call needs one, and a lost sandbox is replaced on the next call.
 */
export class LazySandboxProvider implements SandboxProvider {
	readonly #options: LazySandboxProviderOptions;
	#sandboxId: string | undefined;
	#pending: Promise<Sandbox> | undefined;
	#current: Sandbox | undefined;
	#lastRenewAt = 0;
	#closed = false;

	constructor(options: LazySandboxProviderOptions) {
		this.#options = options;
		this.#sandboxId = options.sandboxId;
	}

	/** Id of the sandbox currently or last provisioned. Persist it to reconnect after a restart. */
	get sandboxId(): string | undefined {
		return this.#sandboxId;
	}

	/** Whether a sandbox is currently provisioned and considered healthy. */
	get isProvisioned(): boolean {
		return this.#current !== undefined;
	}

	async acquire(context: Context): Promise<Result<Sandbox, ExecutionError>> {
		if (this.#closed) return err(new ExecutionError("spawn_error", "Sandbox provider is closed"));
		if (this.#pending === undefined) {
			const pending = this.#provision(context);
			this.#pending = pending;
			pending.catch(() => {
				if (this.#pending === pending) this.#pending = undefined;
			});
		}
		let sandbox: Sandbox;
		try {
			sandbox = await this.#pending;
		} catch (error) {
			const cause = toError(error);
			return err(new ExecutionError("spawn_error", `Sandbox unavailable: ${cause.message}`, cause));
		}
		this.#maybeRenew(sandbox);
		return ok(sandbox);
	}

	invalidate(sandbox: Sandbox, _cause: unknown): void {
		if (this.#current !== sandbox) return;
		this.#current = undefined;
		this.#pending = undefined;
		void sandbox.close().catch(() => undefined);
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
		const current = this.#current;
		this.#current = undefined;
		this.#pending = undefined;
		if (current === undefined) return;
		try {
			if (this.#options.killOnClose) await current.kill();
		} catch {
			// Best-effort release.
		}
		await current.close().catch(() => undefined);
	}

	async #provision(context: Context): Promise<Sandbox> {
		const connectionConfig =
			this.#options.connectionConfig instanceof ConnectionConfig
				? this.#options.connectionConfig
				: new ConnectionConfig(this.#options.connectionConfig);
		let sandbox: Sandbox | undefined;
		let reason: "created" | "connected" = "created";
		if (this.#sandboxId !== undefined) {
			try {
				sandbox = await Sandbox.connect({ connectionConfig, sandboxId: this.#sandboxId });
				reason = "connected";
			} catch {
				sandbox = undefined;
			}
		}
		if (sandbox === undefined) {
			sandbox = await Sandbox.create({ ...this.#options.create, connectionConfig });
		}
		try {
			await this.#options.onProvisioned?.(sandbox, { reason }, context);
		} catch (error) {
			await sandbox.close().catch(() => undefined);
			throw error;
		}
		this.#current = sandbox;
		this.#sandboxId = sandbox.id;
		this.#lastRenewAt = Date.now();
		return sandbox;
	}

	#maybeRenew(sandbox: Sandbox): void {
		const keepAlive = this.#options.keepAlive;
		if (keepAlive === undefined) return;
		const now = Date.now();
		if (now - this.#lastRenewAt < (keepAlive.minIntervalMs ?? 60_000)) return;
		this.#lastRenewAt = now;
		void sandbox.renew(keepAlive.timeoutSeconds).catch(() => undefined);
	}
}

/**
 * Kill a sandbox this process does not own a handle for, by id. Used when taking over a session
 * whose previous worker died: its sandbox may still be executing, so it is stopped before a new one
 * is provisioned. Returns false when the sandbox is already gone or unreachable.
 */
export async function killSandbox(
	connectionConfig: ConnectionConfig | ConnectionConfigOptions,
	sandboxId: string,
): Promise<boolean> {
	const config =
		connectionConfig instanceof ConnectionConfig ? connectionConfig : new ConnectionConfig(connectionConfig);
	let sandbox: Sandbox;
	try {
		sandbox = await Sandbox.connect({ connectionConfig: config, sandboxId });
	} catch {
		return false;
	}
	try {
		await sandbox.kill();
		return true;
	} catch {
		return false;
	} finally {
		await sandbox.close().catch(() => undefined);
	}
}
