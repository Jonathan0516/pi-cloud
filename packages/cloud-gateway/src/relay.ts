/**
 * One authenticated WebSocket presentation, relayed to the node that runs its session.
 *
 * The gateway is an RPC peer in the middle. It answers `Sessions` itself, scoped to the caller's
 * tenant, and forwards every other call to the node; node events flow back untouched. A client
 * therefore speaks exactly the protocol the local TUI speaks, and cannot name a session it does not
 * own: `attach` is the only door and it checks the catalog first.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { connectTcp, WORKSPACE_CWD } from "@earendil-works/pi-cloud-worker";
import { Sessions, type SessionsServiceApi } from "@earendil-works/pi-coding-agent/experimental/mini/shared/protocol";
import { createPeer, type RpcPeer } from "@earendil-works/pi-coding-agent/experimental/mini/shared/rpc";
import type { Connection } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import { type PostgresClient, readSessionLease } from "@earendil-works/pi-session-backend-postgres";
import type { Principal } from "./auth.ts";
import { createTenantSession, findTenantSession, listTenantSessions, liveLease, toSessionSummary } from "./catalog.ts";

const NODE_ATTACH_TIMEOUT_MS = 60_000;

export interface RelayOptions {
	sql: PostgresClient;
	schema: string;
	/** Nodes to hand sessions nobody holds, in preference order. */
	nodes: readonly string[];
	nodeConnectTimeoutMs: number;
	log?: (message: string) => void;
}

/** Pick where a session should be served: its live holder, else the first reachable node. */
export async function resolveNodeAddress(options: RelayOptions, sessionId: string): Promise<string> {
	const lease = liveLease(await readSessionLease(options.sql, sessionId));
	if (lease !== undefined) return lease.owner.addr;
	if (options.nodes.length === 0) throw new Error("No nodes configured");
	return options.nodes[0]!;
}

/** Dial `preferred` first; when it is down, fall through the configured nodes. */
async function dialNode(
	options: RelayOptions,
	preferred: string,
): Promise<{ connection: Connection; address: string }> {
	const candidates = [preferred, ...options.nodes.filter((node) => node !== preferred)];
	let lastError: unknown;
	for (const address of candidates) {
		try {
			return { connection: await connectTcp(address, options.nodeConnectTimeoutMs), address };
		} catch (error) {
			lastError = error;
			options.log?.(`node ${address} unreachable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`No node reachable (${lastError instanceof Error ? lastError.message : String(lastError)})`);
}

/** Serve one presentation connection for `principal` until either side closes. */
export function relayPresentation(connection: Connection, principal: Principal, options: RelayOptions): void {
	const context = BACKGROUND_CONTEXT;
	let node: RpcPeer | undefined;
	let attachedSession: string | undefined;
	const dropNode = (): void => {
		node?.close();
		node = undefined;
		attachedSession = undefined;
	};

	const sessions: SessionsServiceApi = {
		list: async () =>
			(await listTenantSessions(options.sql, principal.tenant)).map((session) =>
				toSessionSummary(options.schema, session),
			),
		attach: async (sessionId, _cwd, presentationId) => {
			let id: string;
			if (sessionId === null) {
				id = (await createTenantSession(options.sql, principal, {}, context)).id;
			} else {
				const owned = await findTenantSession(options.sql, principal.tenant, sessionId);
				if (owned === undefined) throw new Error(`Unknown session: ${sessionId}`);
				id = owned.id;
			}
			dropNode();
			const dialed = await dialNode(options, await resolveNodeAddress(options, id));
			const peer = createPeer(dialed.connection);
			peer.onEvent((service, payload, to) => {
				if (to === undefined || to === presentationId) presentation.emitRaw(service, payload);
			});
			peer.onClose(() => {
				// The node went away under us: the presentation must notice and reattach.
				if (node === peer) {
					node = undefined;
					attachedSession = undefined;
					presentation.close();
				}
			});
			node = peer;
			try {
				await peer.use(Sessions, { timeoutMs: NODE_ATTACH_TIMEOUT_MS }).attach(id, WORKSPACE_CWD, presentationId);
			} catch (error) {
				if (node === peer) dropNode();
				throw error;
			}
			attachedSession = id;
			options.log?.(`${principal.tenant}/${principal.user} attached ${id} via ${dialed.address}`);
			return id;
		},
	};

	const presentation: RpcPeer = createPeer(connection, {
		forward: (method, args) => {
			if (node === undefined || attachedSession === undefined) throw new Error("Not attached to a session");
			return node.call(method, ...args);
		},
	});
	presentation.provide(Sessions, sessions);
	connection.onClose(() => dropNode());
}
