import type { AgentTool } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

/**
 * Regression: steer() must wake hold-blocked follow-up poller.
 *
 * When a tool acquires a hold (e.g., enhanced-bash auto-backgrounding), the
 * agent loop blocks in getFollowUpMessages waiting for the hold to release or
 * a follow-up message to arrive. If the user sends a steering message during
 * this blocked state, the steer was silently enqueued but never woke the
 * waiter, leaving the loop stuck until abort (ESC). The fix adds
 * _wakeWaiters() to Agent.steer().
 */
describe("steer wakes hold-blocked agent loop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("delivers a steering message while a hold keeps the follow-up poller waiting", async () => {
		let releaseHold: (() => void) | undefined;

		const harness = await createHarness();
		harnesses.push(harness);

		const holdTool: AgentTool = {
			name: "hold_tool",
			label: "HoldTool",
			description: "Acquires a hold then returns immediately",
			parameters: Type.Object({}),
			execute: async () => {
				releaseHold = harness.session.agent.acquireHold();
				return {
					content: [{ type: "text", text: "hold acquired" }],
					details: {},
				};
			},
		};

		const releaseTool: AgentTool = {
			name: "release_tool",
			label: "ReleaseTool",
			description: "Releases the hold",
			parameters: Type.Object({}),
			execute: async () => {
				releaseHold?.();
				return {
					content: [{ type: "text", text: "hold released" }],
					details: {},
				};
			},
		};

		harness.session.agent.state.tools = [holdTool, releaseTool];

		// Turn 1: call hold_tool -> acquires hold
		// Turn 2: text only -> loop blocks in getFollowUpMessages (hold active)
		// --- steer sent here, must wake the blocked poller ---
		// Turn 3: steer wakes loop -> LLM sees steer -> calls release_tool to drop the hold
		// Turn 4: loop exits cleanly
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done with tools"),
			fauxAssistantMessage(fauxToolCall("release_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("all done"),
		]);

		const promptPromise = harness.session.prompt("start");

		// Wait for the text-only response. The inner loop will exit and the
		// outer loop will block on getFollowUpMessages because the hold is active.
		await waitForCondition(() => getAssistantTexts(harness).includes("done with tools"), 5000);
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Send a steering message while the loop is blocked.
		// Do NOT release the hold here -- only the steer should wake the waiter.
		// The LLM response to the steer will call release_tool.
		harness.session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "user interruption" }],
			timestamp: Date.now(),
		});

		// Without the fix, promptPromise hangs forever (steer doesn't wake the waiter).
		// With the fix, the steer wakes the waiter and the loop processes it.
		const result = await Promise.race([
			promptPromise.then(() => "resolved" as const),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
		]);

		expect(result).toBe("resolved");
		expect(getUserTexts(harness)).toContain("user interruption");
		expect(getAssistantTexts(harness)).toContain("all done");
	});
});

function waitForCondition(check: () => boolean, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		if (check()) {
			resolve();
			return;
		}
		const interval = setInterval(() => {
			if (check()) {
				clearInterval(interval);
				clearTimeout(timeout);
				resolve();
			}
		}, 10);
		const timeout = setTimeout(() => {
			clearInterval(interval);
			reject(new Error(`Condition not met within ${timeoutMs}ms`));
		}, timeoutMs);
	});
}
