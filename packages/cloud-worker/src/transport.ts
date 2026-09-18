/** TCP transport between nodes and for remote presentations, framed like the unix transport. */

import { createConnection, createServer, type Socket } from "node:net";
import {
	type Connection,
	jsonConnection,
	type Listener,
	type Transport,
} from "@earendil-works/pi-coding-agent/experimental/mini/shared/transport";

function socketConnection(socket: Socket): Connection {
	return jsonConnection(socket, socket, () => socket.destroy());
}

export interface TcpListener extends Listener {
	/** Port actually bound; meaningful when the configured port was 0. */
	readonly port: number;
}

export interface TcpTransport extends Transport {
	listen(onConnection: (connection: Connection) => void): Promise<TcpListener>;
}

export function parseAddress(address: string): { host: string; port: number } {
	const colon = address.lastIndexOf(":");
	if (colon === -1) throw new Error(`Address must be host:port: ${address}`);
	const port = Number.parseInt(address.slice(colon + 1), 10);
	if (!Number.isInteger(port) || port <= 0) throw new Error(`Address has no valid port: ${address}`);
	return { host: address.slice(0, colon), port };
}

/** Dial another node. */
export function connectTcp(address: string, timeoutMs = 5_000): Promise<Connection> {
	const { host, port } = parseAddress(address);
	return new Promise<Connection>((resolve, reject) => {
		const socket = createConnection({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out connecting to ${address}`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socketConnection(socket));
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export function tcpTransport(host: string, port: number): TcpTransport {
	return {
		async listen(onConnection) {
			const server = createServer((socket) => onConnection(socketConnection(socket)));
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, host, resolve);
			});
			const address = server.address();
			const boundPort = typeof address === "object" && address !== null ? address.port : port;
			return {
				port: boundPort,
				close: () =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
					}),
			};
		},
		connect: () => connectTcp(`${host}:${port}`),
	};
}
