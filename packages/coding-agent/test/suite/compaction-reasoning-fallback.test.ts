import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const truncated = fauxAssistantMessage("partial checkpoint", { stopReason: "length" });
const complete = fauxAssistantMessage("complete checkpoint");
const disconnected = fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });

describe("compaction reasoning fallback", () => {
	let harness: Harness;

	afterEach(() => harness?.cleanup());

	async function setup(kind: "history" | "prefix" = "history", maxRetries = 0): Promise<void> {
		harness = await createHarness({
			models: [{ id: "reasoning-model", reasoning: true, maxTokens: 128000, contextWindow: 1000000 }],
			settings: {
				defaultThinkingLevel: "high",
				compaction: { enabled: true, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries, baseDelayMs: 0 },
			},
		});
		harness.session.setThinkingLevel("high");
		harness.sessionManager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("old answer", { timestamp: 2 }));
		if (kind === "history") {
			harness.sessionManager.appendMessage({ role: "user", content: "recent request", timestamp: 3 });
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	function respondWith(responses: AssistantMessage[]): Array<SimpleStreamOptions | undefined> {
		const requests: Array<SimpleStreamOptions | undefined> = [];
		harness.setResponses(
			responses.map((response) => (_context, options) => {
				requests.push(options);
				return response;
			}),
		);
		return requests;
	}

	it.each(["history", "prefix"] as const)("lowers %s-summary reasoning after two token-cap failures", async (kind) => {
		await setup(kind);
		const requests = respondWith([truncated, truncated, complete]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("complete checkpoint");
		expect(result.summary).not.toContain("partial checkpoint");
		expect(requests.map((options) => options?.reasoning)).toEqual(["high", "high", "medium"]);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(harness.eventsOfType("summarization_retry_scheduled").at(-1)?.errorMessage).toContain(
			"lowering compaction reasoning from high to medium",
		);
		expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("continues down the entire ladder, including off, without lowering normal chat reasoning", async () => {
		await setup();
		const requests = respondWith([
			...Array.from({ length: 8 }, () => truncated),
			complete,
			fauxAssistantMessage("chat"),
		]);

		await harness.session.compact();
		harness.settingsManager.applyOverrides({ compaction: { enabled: false } });
		await harness.session.prompt("Continue normally");

		expect(requests.map((options) => options?.reasoning)).toEqual([
			"high",
			"high",
			"medium",
			"medium",
			"low",
			"low",
			"minimal",
			"minimal",
			undefined,
			"high",
		]);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("high");
	});

	it("stops after a final capped attempt with thinking off and never persists partial output", async () => {
		await setup();
		const requests = respondWith(Array.from({ length: 9 }, () => truncated));

		await expect(harness.session.compact()).rejects.toThrow("generation hit the token cap");

		expect(requests).toHaveLength(9);
		expect(requests.at(-1)?.reasoning).toBeUndefined();
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("generation hit the token cap");
	});

	it("restarts the consecutive-failure count after a transient failure", async () => {
		await setup("history", 1);
		const requests = respondWith([truncated, disconnected, truncated, truncated, complete]);

		await harness.session.compact();

		expect(requests.map((options) => options?.reasoning)).toEqual(["high", "high", "high", "high", "medium"]);
	});

	it("does not multiply the transient-error budget by the number of reasoning levels", async () => {
		await setup("history", 1);
		const requests = respondWith([truncated, disconnected, truncated, disconnected]);

		await expect(harness.session.compact()).rejects.toThrow("terminated");

		expect(requests).toHaveLength(4);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("still completes the ladder when each allowed transient failure interrupts a pair", async () => {
		await setup("history", 3);
		const requests = respondWith([
			truncated,
			disconnected,
			truncated,
			disconnected,
			truncated,
			disconnected,
			...Array.from({ length: 8 }, () => truncated),
			complete,
		]);

		await harness.session.compact();

		expect(requests).toHaveLength(15);
		expect(requests.at(-1)?.reasoning).toBeUndefined();
	});

	it("honors disabled retries", async () => {
		await setup();
		harness.settingsManager.applyOverrides({ retry: { enabled: false } });
		const requests = respondWith([truncated]);

		await expect(harness.session.compact()).rejects.toThrow("generation hit the token cap");

		expect(requests).toHaveLength(1);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
	});

	it("aborts token-cap recovery during backoff without changing session reasoning", async () => {
		await setup();
		harness.settingsManager.applyOverrides({ retry: { baseDelayMs: 30000 } });
		const requests = respondWith([truncated]);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "summarization_retry_scheduled") harness.session.abortCompaction();
		});

		try {
			await expect(harness.session.compact()).rejects.toThrow();
		} finally {
			unsubscribe();
		}

		expect(requests).toHaveLength(1);
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("uses the same fallback for automatic threshold compaction", async () => {
		await setup();
		harness.getModel().contextWindow = 100;
		harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 99 } });
		respondWith([truncated, truncated, complete, fauxAssistantMessage("continued")]);

		await harness.session.prompt("Continue after compaction");

		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ reason: "threshold", aborted: false });
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});
});
