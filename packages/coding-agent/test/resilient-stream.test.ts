import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { makeResilientStreamFn } from "../src/core/resilient-stream.ts";
import { TTFETracker } from "../src/core/ttfe-tracker.ts";

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context: TranscriptContext = normalizeContext({ messages: [] });

function buildMessage(stopReason: "stop" | "error" | "aborted", text?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(text === undefined ? {} : { errorMessage: text }),
		timestamp: Date.now(),
	};
}

/**
 * Mimics pi-ai's openai-completions stream when its signal aborts before any
 * event: emits a terminal error event whose reason follows the signal state.
 */
function stallingInner(counter: { attempts: number }): StreamFunction<"openai-completions"> {
	return (_model, _context, opts) => {
		counter.attempts++;
		const signal = opts?.signal;
		const stream = createAssistantMessageEventStream();
		signal?.addEventListener(
			"abort",
			() => {
				const aborted = signal.aborted;
				const reason = aborted ? "aborted" : "error";
				stream.push({
					type: "error",
					reason,
					error: buildMessage(reason, aborted ? "Request was aborted" : "boom"),
				});
				stream.end();
			},
			{ once: true },
		);
		// Never emits anything until the watchdog aborts the signal.
		return stream;
	};
}

/** Stall variant where the hang manifests as a rejected iterator instead of an error event. */
function throwingInner(counter: { attempts: number }): StreamFunction<"openai-completions"> {
	return (_model, _context, opts) => {
		counter.attempts++;
		const signal = opts?.signal;
		const hung = (async function* () {
			await new Promise<void>((resolve) => {
				if (signal === undefined || signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("inner iterator rejected after abort");
		})();
		return {
			[Symbol.asyncIterator]: () => hung,
		} as unknown as AssistantMessageEventStream;
	};
}

async function collect(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return { events, final: await stream.result() };
}

describe("resilient stream TTFE exhaustion", () => {
	it("labels watchdog exhaustion as error, not user abort", async () => {
		const counter = { attempts: 0 };
		const resilient = makeResilientStreamFn(stallingInner(counter), {
			tracker: new TTFETracker(),
			config: { hardCapMs: 50, maxAttempts: 3 },
		});
		const { events, final } = await collect(resilient(model, context));
		expect(counter.attempts).toBe(3);
		expect(final.stopReason).toBe("error");
		expect(final.errorMessage ?? "").toMatch(/no response|first-response|stall/i);
		expect(events.filter((e) => e.type === "error")).toHaveLength(1);
	}, 15000);

	it("retries a hung iterator and labels exhaustion as error", async () => {
		const counter = { attempts: 0 };
		const resilient = makeResilientStreamFn(throwingInner(counter), {
			tracker: new TTFETracker(),
			config: { hardCapMs: 50, maxAttempts: 3 },
		});
		const { final } = await collect(resilient(model, context));
		expect(counter.attempts).toBe(3);
		expect(final.stopReason).toBe("error");
	}, 15000);

	it("user abort still surfaces immediately as aborted", async () => {
		const counter = { attempts: 0 };
		const userController = new AbortController();
		const resilient = makeResilientStreamFn(stallingInner(counter), {
			tracker: new TTFETracker(),
			config: { hardCapMs: 5000, maxAttempts: 3 },
		});
		const pending = collect(resilient(model, context, { signal: userController.signal }));
		setTimeout(() => userController.abort(), 20);
		const { final } = await pending;
		expect(counter.attempts).toBe(1);
		expect(final.stopReason).toBe("aborted");
	}, 15000);

	it("passes through a healthy stream untouched", async () => {
		const counter = { attempts: 0 };
		const inner: StreamFunction<"openai-completions"> = () => {
			counter.attempts++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: buildMessage("stop") });
			});
			return stream;
		};
		const resilient = makeResilientStreamFn(inner, {
			tracker: new TTFETracker(),
			config: { hardCapMs: 50, maxAttempts: 3 },
		});
		const { events, final } = await collect(resilient(model, context));
		expect(counter.attempts).toBe(1);
		expect(final.stopReason).toBe("stop");
		expect(events.filter((e) => e.type === "done")).toHaveLength(1);
	}, 15000);
});
