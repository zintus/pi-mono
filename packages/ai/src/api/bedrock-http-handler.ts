import type { Agent as HttpsAgent } from "node:https";
import { NodeHttp2Handler, NodeHttpHandler } from "@smithy/node-http-handler";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { registerSessionResourceCleanup } from "../session-resources.ts";

const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_HANDLERS = 16;

type Handler = NodeHttp2Handler | NodeHttpHandler;
interface Entry {
	handler: Handler;
	active: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

const handlers = new Map<string, Entry>();

/**
 * Share only transport state. SDK clients, signing credentials and middleware stay
 * request-local. Smithy separates connections by destination and unrefs idle sockets.
 * A lease lasts through body consumption, not just receipt of response headers.
 */
export function acquireBedrockHttpHandler(
	endpointKey: string,
	proxyUrl: URL | undefined,
	forceHttp1: boolean,
	timeoutMs: number | undefined,
): { handler: Handler; headersTimeoutMs: number | undefined; release: () => void } {
	const http1 = Boolean(proxyUrl) || forceHttp1;
	// Bun delegates Http2Stream.setTimeout to the session, leaking one callback
	// per request and coupling concurrent streams' timeouts. The adapter enforces
	// header/event idleness instead; Node keeps Smithy's per-stream timeout.
	const bunHttp2 = !http1 && Boolean(process.versions.bun);
	const key = JSON.stringify([endpointKey, proxyUrl?.href, http1, timeoutMs]);
	let entry = handlers.get(key);
	if (!entry) {
		// Evict only idle entries. If all slots are busy, use an uncached handler
		// rather than interrupting a stream or growing the cache without a bound.
		if (handlers.size >= MAX_HANDLERS) {
			for (const [idleKey, idleEntry] of handlers) {
				if (idleEntry.active !== 0) continue;
				clearTimeout(idleEntry.idleTimer);
				handlers.delete(idleKey);
				idleEntry.handler.destroy();
				break;
			}
		}
		entry = {
			handler: http1
				? new NodeHttpHandler({
						socketTimeout: timeoutMs,
						...(proxyUrl && {
							httpAgent: new HttpProxyAgent(proxyUrl, { keepAlive: true }),
							httpsAgent: new HttpsProxyAgent(proxyUrl, { keepAlive: true }) as unknown as HttpsAgent,
						}),
					})
				: new NodeHttp2Handler({ requestTimeout: bunHttp2 ? 0 : timeoutMs }),
			active: 0,
		};
		if (handlers.size < MAX_HANDLERS) handlers.set(key, entry);
	}
	clearTimeout(entry.idleTimer);
	entry.active++;
	const leased = entry;
	let released = false;
	return {
		handler: leased.handler,
		headersTimeoutMs: bunHttp2 ? timeoutMs : undefined,
		release: () => {
			if (released) return;
			released = true;
			if (--leased.active !== 0) return;
			if (handlers.get(key) !== leased) {
				leased.handler.destroy();
				return;
			}
			// Refresh insertion order so capacity eviction removes the oldest idle entry.
			handlers.delete(key);
			handlers.set(key, leased);
			leased.idleTimer = setTimeout(() => {
				handlers.delete(key);
				leased.handler.destroy();
			}, IDLE_TIMEOUT_MS);
			leased.idleTimer.unref();
		},
	};
}

registerSessionResourceCleanup((sessionId) => {
	// These pools are shared across sessions; closing one session must not affect
	// another. Global cleanup retires active entries until their last lease ends.
	if (sessionId !== undefined) return;
	for (const entry of handlers.values()) {
		clearTimeout(entry.idleTimer);
		if (entry.active === 0) entry.handler.destroy();
	}
	handlers.clear();
});
