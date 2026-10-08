import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@smithy/node-http-handler", () => {
	class NodeHttpHandler {
		config: Record<string, unknown>;
		destroy = vi.fn();
		httpHandlerConfigs() {
			return this.config;
		}
		constructor(config: Record<string, unknown>) {
			this.config = config;
		}
	}
	class NodeHttp2Handler extends NodeHttpHandler {}
	return { NodeHttpHandler, NodeHttp2Handler };
});

import { NodeHttp2Handler, NodeHttpHandler } from "@smithy/node-http-handler";
import { acquireBedrockHttpHandler } from "../src/api/bedrock-http-handler.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";

const IDLE_MS = 300_000;
const acquire = (endpoint = "east", timeout: number | undefined = undefined, proxy?: URL, http1 = false) =>
	acquireBedrockHttpHandler(endpoint, proxy, http1, timeout);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	cleanupSessionResources();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Bedrock HTTP handler leases", () => {
	it("reuses concurrent and sequential leases until the idle expiry", () => {
		const a = acquire();
		const b = acquire();
		expect(a.handler).toBeInstanceOf(NodeHttp2Handler);
		expect(b.handler).toBe(a.handler);
		a.release();
		a.release(); // idempotent, does not release b's lease
		vi.advanceTimersByTime(IDLE_MS * 2);
		expect(a.handler.destroy).not.toHaveBeenCalled();
		b.release();
		vi.advanceTimersByTime(IDLE_MS - 1);
		const c = acquire();
		expect(c.handler).toBe(a.handler);
		vi.advanceTimersByTime(IDLE_MS);
		expect(a.handler.destroy).not.toHaveBeenCalled();
		c.release();
		vi.advanceTimersByTime(IDLE_MS);
		expect(a.handler.destroy).toHaveBeenCalledTimes(1);
		const d = acquire();
		expect(d.handler).not.toBe(a.handler);
		d.release();
	});

	it("separates endpoints, timeout values, proxy URLs and HTTP versions", () => {
		const leases = [
			acquire(),
			acquire("west"),
			acquire("east", 0),
			acquire("east", 100),
			acquire("east", undefined, undefined, true),
			acquire("east", undefined, new URL("http://localhost:9001")),
			acquire("east", undefined, new URL("http://localhost:9002")),
		];
		expect(new Set(leases.map((lease) => lease.handler)).size).toBe(leases.length);
		expect(leases[4].handler).toBeInstanceOf(NodeHttpHandler);
		expect(leases[4].handler).not.toBeInstanceOf(NodeHttp2Handler);
		const sameProxy = acquire("east", undefined, new URL("http://localhost:9001"), true);
		expect(sameProxy.handler).toBe(leases[5].handler);
		for (const lease of [...leases, sameProxy]) lease.release();
	});

	it("uses the adapter timeout guard instead of Bun's session-wide HTTP/2 timeout", () => {
		vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "test" } });
		const h2 = acquire("east", 1234);
		expect(h2.handler.httpHandlerConfigs()).toEqual({ requestTimeout: 0 });
		expect(h2.headersTimeoutMs).toBe(1234);
		const h1 = acquire("east", 1234, undefined, true);
		expect(h1.handler.httpHandlerConfigs()).toMatchObject({ socketTimeout: 1234 });
		expect(h1.headersTimeoutMs).toBeUndefined();
		h2.release();
		h1.release();
	});

	it("evicts idle entries at capacity without destroying active streams", () => {
		const leases = Array.from({ length: 16 }, (_, i) => acquire(String(i)));
		leases[3].release();
		const extra = acquire("extra");
		expect(leases[3].handler.destroy).toHaveBeenCalledTimes(1);
		for (const [i, lease] of leases.entries()) {
			if (i !== 3) expect(lease.handler.destroy).not.toHaveBeenCalled();
			lease.release();
		}
		extra.release();
	});

	it("destroys overflow handlers on release when every cached slot is active", () => {
		const leases = Array.from({ length: 16 }, (_, i) => acquire(String(i)));
		const extra = acquire("overflow");
		extra.release();
		expect(extra.handler.destroy).toHaveBeenCalledTimes(1);
		for (const lease of leases) {
			expect(lease.handler.destroy).not.toHaveBeenCalled();
			lease.release();
		}
	});

	it("global cleanup retires active handlers; per-session cleanup leaves shared pools alone", () => {
		const active = acquire();
		const idle = acquire("idle");
		idle.release();
		cleanupSessionResources("one-session");
		expect(active.handler.destroy).not.toHaveBeenCalled();
		expect(idle.handler.destroy).not.toHaveBeenCalled();
		cleanupSessionResources();
		expect(active.handler.destroy).not.toHaveBeenCalled();
		expect(idle.handler.destroy).toHaveBeenCalledTimes(1);
		const next = acquire();
		expect(next.handler).not.toBe(active.handler);
		active.release();
		expect(active.handler.destroy).toHaveBeenCalledTimes(1);
		next.release();
		vi.advanceTimersByTime(IDLE_MS);
		expect(next.handler.destroy).toHaveBeenCalledTimes(1);
		expect(idle.handler.destroy).toHaveBeenCalledTimes(1);
	});
});
