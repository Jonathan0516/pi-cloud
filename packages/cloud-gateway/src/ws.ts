/**
 * The mini RPC over WebSocket: one JSON frame per text message. Browsers cannot send an
 * `Authorization` header on a WebSocket, so the key may also travel as the `bearer.<key>`
 * subprotocol next to `pi-cloud.v1`; the gateway answers with `pi-cloud.v1` alone.
 */

import type { Connection, Transport } from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";
import type { WebSocket as ServerWebSocket } from "ws";

export const WS_PROTOCOL = "pi-cloud.v1";
const BEARER_PROTOCOL_PREFIX = "bearer.";

/** Read the API key a browser client put in `Sec-WebSocket-Protocol`. */
export function bearerFromProtocols(header: string | undefined): string | undefined {
	if (header === undefined) return undefined;
	for (const raw of header.split(",")) {
		const protocol = raw.trim();
		if (protocol.startsWith(BEARER_PROTOCOL_PREFIX)) return protocol.slice(BEARER_PROTOCOL_PREFIX.length);
	}
	return undefined;
}

export function protocolsFor(apiKey: string): string[] {
	return [WS_PROTOCOL, `${BEARER_PROTOCOL_PREFIX}${apiKey}`];
}

/** Server side: wrap an accepted `ws` socket. */
export function serverWebSocketConnection(socket: ServerWebSocket): Connection {
	const messageHandlers: ((message: unknown) => void)[] = [];
	const closeHandlers: (() => void)[] = [];
	let closed = false;
	const notifyClosed = (): void => {
		if (closed) return;
		closed = true;
		for (const handler of closeHandlers) handler();
	};
	socket.on("message", (data, isBinary) => {
		if (isBinary || closed) return;
		let message: unknown;
		try {
			message = JSON.parse(data.toString());
		} catch {
			socket.close(1003, "frames must be JSON");
			return;
		}
		for (const handler of messageHandlers) handler(message);
	});
	socket.once("close", notifyClosed);
	socket.once("error", notifyClosed);
	return {
		send: (message) => {
			if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
		},
		onMessage: (handler) => messageHandlers.push(handler),
		onClose: (handler) => closeHandlers.push(handler),
		close: () => {
			notifyClosed();
			socket.close(1000);
		},
	};
}

/** Client side: wrap a standard `WebSocket` (Node 22+, browsers). Resolves once open. */
export function clientWebSocketConnection(socket: WebSocket): Promise<Connection> {
	return new Promise<Connection>((resolve, reject) => {
		const messageHandlers: ((message: unknown) => void)[] = [];
		const closeHandlers: (() => void)[] = [];
		let closed = false;
		let opened = false;
		const notifyClosed = (): void => {
			if (closed) return;
			closed = true;
			for (const handler of closeHandlers) handler();
		};
		socket.addEventListener("message", (event) => {
			if (closed || typeof event.data !== "string") return;
			const message: unknown = JSON.parse(event.data);
			for (const handler of messageHandlers) handler(message);
		});
		socket.addEventListener("close", (event) => {
			if (!opened) reject(new Error(`WebSocket closed before opening (${event.code} ${event.reason})`));
			notifyClosed();
		});
		socket.addEventListener("error", () => {
			if (!opened) reject(new Error("WebSocket connection failed"));
			notifyClosed();
		});
		socket.addEventListener("open", () => {
			opened = true;
			resolve({
				send: (message) => {
					if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
				},
				onMessage: (handler) => messageHandlers.push(handler),
				onClose: (handler) => closeHandlers.push(handler),
				close: () => {
					notifyClosed();
					socket.close(1000);
				},
			});
		});
	});
}

/** A mini `Transport` that dials the gateway. `listen` is not supported: only the gateway listens. */
export function webSocketTransport(url: string, apiKey: string): Transport {
	return {
		listen: () => Promise.reject(new Error("The WebSocket transport only connects")),
		connect: () => clientWebSocketConnection(new WebSocket(url, protocolsFor(apiKey))),
	};
}
