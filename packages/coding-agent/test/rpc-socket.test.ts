import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import { startRpcSocket } from "../src/modes/rpc/rpc-socket.ts";

function fakeSession() {
	const listeners = new Set<(event: object) => void>();
	return {
		sessionManager: { getLeafId: () => "leaf" },
		subscribe: vi.fn((listener: (event: object) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
		emit: (event: object) => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("RPC socket session subscriptions", () => {
	it.each(
		["new_session", "switch_session", "fork", "clone"].flatMap((type) =>
			[false, true].map((cancelled) => ({ type, cancelled })),
		),
	)("follows $type without rebinding extensions (cancelled=$cancelled)", async ({ type, cancelled }) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rpc-"));
		const oldSession = fakeSession();
		const newSession = fakeSession();
		const replace = vi.fn(async () => {
			if (!cancelled) runtime.session = newSession;
			return { cancelled, selectedText: "selected" };
		});
		const runtime = {
			session: oldSession,
			newSession: replace,
			switchSession: replace,
			fork: replace,
		};
		const server = await startRpcSocket(runtime as unknown as AgentSessionRuntime, join(dir, "rpc.sock"));
		const client = createConnection(server.path);
		const records: Record<string, unknown>[] = [];
		const detach = attachJsonlLineReader(client, (line) => records.push(JSON.parse(line)));
		try {
			await once(client, "connect");
			client.write(`${JSON.stringify({ id: "replace", type, sessionPath: "session.jsonl", entryId: "entry" })}\n`);
			await vi.waitFor(() => {
				expect(records).toContainEqual(expect.objectContaining({ id: "replace", success: true }));
			});
			expect(replace).toHaveBeenCalledTimes(1);
			expect(oldSession.subscribe).toHaveBeenCalledTimes(1);
			expect(newSession.subscribe).toHaveBeenCalledTimes(cancelled ? 0 : 1);

			oldSession.emit({ type: "queue_update", steering: ["old"], followUp: [] });
			newSession.emit({ type: "queue_update", steering: ["new"], followUp: [] });
			// A response after the events is a stream-order barrier for their delivery.
			client.write(`${JSON.stringify({ id: "barrier", type: "get_system_prompt" })}\n`);
			await vi.waitFor(() => {
				expect(records).toContainEqual(expect.objectContaining({ id: "barrier", success: true }));
			});
			expect(records.filter((record) => record.type === "queue_update")).toEqual([
				{ type: "queue_update", steering: [cancelled ? "old" : "new"], followUp: [] },
			]);
		} finally {
			detach();
			const closed = once(client, "close");
			client.destroy();
			await closed;
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
