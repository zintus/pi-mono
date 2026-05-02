import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { createRpcCommandHandler } from "./rpc-mode.ts";
import type { RpcCommand, RpcExtensionUIRequest, RpcResponse } from "./rpc-types.ts";

export interface RpcSocketServer {
	path: string;
	close(): Promise<void>;
}

export async function startRpcSocket(runtimeHost: AgentSessionRuntime, socketPath: string): Promise<RpcSocketServer> {
	fs.mkdirSync(path.dirname(socketPath), { recursive: true });
	try {
		fs.unlinkSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	const server = net.createServer((socket) => {
		socket.on("error", () => undefined);
		const write = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
			if (!socket.destroyed && socket.writable) {
				socket.write(serializeJsonLine(obj));
			}
		};
		const success = <T extends RpcCommand["type"]>(
			id: string | undefined,
			command: T,
			data?: object | null,
		): RpcResponse => {
			if (data === undefined) {
				return { id, type: "response", command, success: true } as RpcResponse;
			}
			return {
				id,
				type: "response",
				command,
				success: true,
				data,
			} as RpcResponse;
		};
		const error = (id: string | undefined, command: string, message: string): RpcResponse => ({
			id,
			type: "response",
			command,
			success: false,
			error: message,
		});
		let unsubscribeSession: (() => void) | undefined;
		const subscribeSession = () => {
			unsubscribeSession?.();
			unsubscribeSession = runtimeHost.session.subscribe((event) => write(event));
		};
		subscribeSession();
		const handleCommand = createRpcCommandHandler({
			runtimeHost,
			getSession: () => runtimeHost.session,
			rebindSession: async () => {
				subscribeSession();
			},
			output: write,
			success,
			error,
		});

		const detachJsonl = attachJsonlLineReader(socket, (line) => {
			if (line.trim() === "") return;
			let command: RpcCommand;
			try {
				command = JSON.parse(line) as RpcCommand;
			} catch (parseError) {
				write(
					error(
						undefined,
						"parse",
						`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					),
				);
				return;
			}
			void handleCommand(command)
				.then((response) => {
					if (response) write(response);
				})
				.catch((handlerError) => {
					write(
						error(
							command.id,
							command.type,
							handlerError instanceof Error ? handlerError.message : String(handlerError),
						),
					);
				});
		});
		socket.on("close", () => {
			detachJsonl();
			unsubscribeSession?.();
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
	fs.chmodSync(socketPath, 0o600);

	return {
		path: socketPath,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					try {
						fs.unlinkSync(socketPath);
					} catch (unlinkError) {
						if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
							reject(unlinkError);
							return;
						}
					}
					if (error) reject(error);
					else resolve();
				});
			}),
	};
}
