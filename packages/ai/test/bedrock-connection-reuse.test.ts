import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session } from "node:http2";
import type { Socket } from "node:net";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const codec = new EventStreamCodec(
	(bytes) => new TextDecoder().decode(bytes),
	(text) => new TextEncoder().encode(text),
);
function event(type: string, body: object): Uint8Array {
	return codec.encode({
		headers: {
			":message-type": { type: "string", value: "event" },
			":event-type": { type: "string", value: type },
			":content-type": { type: "string", value: "application/json" },
		},
		body: new TextEncoder().encode(JSON.stringify(body)),
	});
}
const body = Buffer.concat([
	event("messageStart", { role: "assistant" }),
	event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "OK" } }),
	event("contentBlockStop", { contentBlockIndex: 0 }),
	event("messageStop", { stopReason: "end_turn" }),
	event("metadata", { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }),
]);
const model: Model<"bedrock-converse-stream"> = {
	id: "global.openai.gpt-6-astra",
	name: "Astra",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 128,
};
const context = normalizeContext({ messages: [{ role: "user", content: "Say OK.", timestamp: 0 }] });
const env = {
	NO_PROXY: "*",
	AWS_PROFILE: "",
	AWS_BEDROCK_FORCE_HTTP1: "",
	AWS_BEARER_TOKEN_BEDROCK: "",
	AWS_ACCESS_KEY_ID: "test-access-one",
	AWS_SECRET_ACCESS_KEY: "test-secret",
	AWS_SESSION_TOKEN: "",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	cleanupSessionResources();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllGlobals();
});

async function h2Fixture() {
	const server = createHttp2Server();
	const sessions: ServerHttp2Session[] = [];
	const headers: Array<Record<string, unknown>> = [];
	let onHang = () => {};
	server.on("session", (session) => sessions.push(session));
	server.on("stream", (stream, requestHeaders) => {
		stream.on("error", () => {});
		stream.resume();
		headers.push({ ...requestHeaders });
		if (requestHeaders["x-action"] === "headers-hang") {
			onHang();
			return;
		}
		stream.respond({
			":status": 200,
			"content-type": "application/vnd.amazon.eventstream",
			"x-probe": requestHeaders["x-probe"] ?? "",
		});
		if (requestHeaders["x-action"] === "hang") {
			stream.write(event("messageStart", { role: "assistant" }));
			onHang();
		} else {
			stream.end(body);
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanups.push(async () => {
		for (const session of sessions) session.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No server port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		sessions,
		headers,
		waitForHang: () =>
			new Promise<void>((resolve) => {
				onHang = resolve;
			}),
	};
}

describe("Bedrock connection reuse through the real SDK", () => {
	it("reuses HTTP/2 across model families without leaking headers, callbacks or rotated credentials", async () => {
		const fixture = await h2Fixture();
		const seen: string[][] = [[], []];
		for (const [i, id] of [model.id, "global.anthropic.claude-opus-5-5"].entries()) {
			const result = await streamBedrock({ ...model, id, baseUrl: fixture.url }, context, {
				env: { ...env, AWS_ACCESS_KEY_ID: i === 0 ? "test-access-one" : "test-access-two" },
				region: "us-east-2",
				headers: { "x-probe": String(i) },
				onResponse: (response) => {
					seen[i].push(response.headers["x-probe"]);
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toMatchObject([{ type: "text", text: "OK" }]);
		}
		expect(fixture.sessions).toHaveLength(1);
		expect(seen).toEqual([["0"], ["1"]]);
		expect(fixture.headers.map((h) => h["x-probe"])).toEqual(["0", "1"]);
		expect(fixture.headers[0].authorization).toContain("Credential=test-access-one/");
		expect(fixture.headers[1].authorization).toContain("Credential=test-access-two/");
	});

	it("isolates destinations and reuses each one's connection", async () => {
		const fixtures = await Promise.all([h2Fixture(), h2Fixture()]);
		for (const fixture of [...fixtures, ...fixtures]) {
			const result = await streamBedrock({ ...model, baseUrl: fixture.url }, context, {
				env,
				region: "us-east-2",
			}).result();
			expect(result.stopReason).toBe("stop");
		}
		for (const fixture of fixtures) expect(fixture.sessions).toHaveLength(1);
	});

	it("aborts only the requested stream, not a concurrent stream or its shared connection", async () => {
		const fixture = await h2Fixture();
		const controller = new AbortController();
		const started = fixture.waitForHang();
		const stalled = streamBedrock({ ...model, baseUrl: fixture.url }, context, {
			env,
			region: "us-east-2",
			signal: controller.signal,
			headers: { "x-action": "hang" },
		});
		await started;
		const healthy = await streamBedrock({ ...model, baseUrl: fixture.url }, context, {
			env,
			region: "us-east-2",
		}).result();
		expect(healthy.stopReason).toBe("stop");
		controller.abort();
		expect((await stalled.result()).stopReason).toBe("aborted");
		const next = await streamBedrock({ ...model, baseUrl: fixture.url }, context, {
			env,
			region: "us-east-2",
		}).result();
		expect(next.stopReason).toBe("stop");
		expect(fixture.sessions).toHaveLength(1);
	});

	it("an idle timeout cancels just its stream and leaves the connection reusable", async () => {
		const fixture = await h2Fixture();
		const options = { env, region: "us-east-2", timeoutMs: 200 };
		const started = fixture.waitForHang();
		const stalled = streamBedrock({ ...model, baseUrl: fixture.url }, context, {
			...options,
			headers: { "x-action": "hang" },
		});
		await started;
		expect((await streamBedrock({ ...model, baseUrl: fixture.url }, context, options).result()).stopReason).toBe(
			"stop",
		);
		const failed = await stalled.result();
		expect(failed.stopReason).toBe("error");
		// Smithy's stream timeout can close the body just before our event watchdog
		// fires; either path must fail the stalled request without poisoning the pool.
		expect(failed.errorMessage).toMatch(/timed out|ended without a stop reason/i);
		expect((await streamBedrock({ ...model, baseUrl: fixture.url }, context, options).result()).stopReason).toBe(
			"stop",
		);
		expect(fixture.sessions).toHaveLength(1);
	});

	it.each(["headers-hang", "hang"])("Bun's adapter watchdog bounds %s without a session timeout", async (action) => {
		vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "test" } });
		const fixture = await h2Fixture();
		const options = { env, region: "us-east-2", timeoutMs: 200 };
		const failed = await streamBedrock({ ...model, baseUrl: fixture.url }, context, {
			...options,
			headers: { "x-action": action },
		}).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("Bedrock stream timed out after 200ms without activity");
		expect((await streamBedrock({ ...model, baseUrl: fixture.url }, context, options).result()).stopReason).toBe(
			"stop",
		);
		expect(fixture.sessions).toHaveLength(1);
	});

	it("closes an unread response when a stream observer throws", async () => {
		const fixture = await h2Fixture();
		const failed = await streamBedrock({ ...model, baseUrl: fixture.url }, context, {
			env,
			region: "us-east-2",
			headers: { "x-action": "hang" },
			onProviderStreamEvent: () => {
				throw new Error("observer failed");
			},
		}).result();
		expect(failed.errorMessage).toBe("observer failed");
		expect(
			(await streamBedrock({ ...model, baseUrl: fixture.url }, context, { env, region: "us-east-2" }).result())
				.stopReason,
		).toBe("stop");
		expect(fixture.sessions).toHaveLength(1);
	});

	it("recovers after a peer closes an idle HTTP/2 connection", async () => {
		const fixture = await h2Fixture();
		const drive = () =>
			streamBedrock({ ...model, baseUrl: fixture.url }, context, { env, region: "us-east-2" }).result();
		expect((await drive()).stopReason).toBe("stop");
		fixture.sessions[0].close();
		await once(fixture.sessions[0], "close");
		expect((await drive()).stopReason).toBe("stop");
		expect(fixture.sessions).toHaveLength(2);
	});

	it("reuses forced HTTP/1.1 connections too", async () => {
		const sockets: Socket[] = [];
		const server = createHttpServer((req, res) => {
			req.resume();
			res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
			res.end(body);
		});
		server.on("connection", (socket) => sockets.push(socket));
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No server port");
		for (let i = 0; i < 2; i++) {
			const result = await streamBedrock({ ...model, baseUrl: `http://127.0.0.1:${address.port}` }, context, {
				env: { ...env, AWS_BEDROCK_FORCE_HTTP1: "1" },
				region: "us-east-2",
			}).result();
			expect(result.stopReason).toBe("stop");
		}
		expect(sockets).toHaveLength(1);
	});
});
