import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function response(stopReason: "stop" | "error" | "aborted" = "stop") {
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected event type");
		},
	);
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
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
		timestamp: 0,
	};
	if (stopReason === "stop") stream.push({ type: "done", reason: "stop", message });
	else stream.push({ type: "error", reason: stopReason, error: message });
	return stream;
}

const baseConfig: AgentLoopConfig = {
	model,
	convertToLlm: (messages) =>
		messages.filter(
			(message) =>
				message.role === "system" ||
				message.role === "user" ||
				message.role === "assistant" ||
				message.role === "toolResult",
		),
};
const prompt: AgentMessage = { role: "user", content: "run", timestamp: 0 };

describe.each([false, true])("beforeIdle with explicit continuation=%s", (explicitContinuation) => {
	it.each(["none", "steering", "follow-up"])("preserves %s scheduling without an extra request", async (queueKind) => {
		let idleCalls = 0;
		let finishCalls = 0;
		const steering: AgentMessage[] = [];
		const followUp: AgentMessage[] = [];
		const requestUsers: string[][] = [];
		const streamFn: StreamFn = (_model, context) => {
			requestUsers.push(
				context.messages.flatMap((message) =>
					message.role === "user" && typeof message.content === "string" ? [message.content] : [],
				),
			);
			return response();
		};
		await runAgentLoop(
			[prompt],
			{ messages: [], tools: [] },
			{
				...baseConfig,
				finishTurn: () => {
					finishCalls++;
					if (explicitContinuation && finishCalls === 1) return { action: "continue" };
				},
				beforeIdle: async () => {
					idleCalls++;
					if (idleCalls !== 1 || queueKind === "none") return;
					const queue = queueKind === "steering" ? steering : followUp;
					queue.push({ role: "user", content: "queued by beforeIdle", timestamp: 1 });
				},
				getSteeringMessages: async () => steering.splice(0),
				getFollowUpMessages: async () => followUp.splice(0),
			},
			() => {},
			undefined,
			streamFn,
		);

		const expectedRequests = explicitContinuation || queueKind !== "none" ? 2 : 1;
		expect(requestUsers).toHaveLength(expectedRequests);
		expect(idleCalls).toBe(expectedRequests);
		if (queueKind !== "none") expect(requestUsers[1]).toEqual(["run", "queued by beforeIdle"]);
	});
});

describe("beforeIdle hard exits", () => {
	it.each(["end", "error", "aborted"] as const)("does not revive an %s turn", async (exitKind) => {
		let idleCalls = 0;
		let providerCalls = 0;
		await runAgentLoop(
			[prompt],
			{ messages: [], tools: [] },
			{
				...baseConfig,
				finishTurn: () => ({ action: exitKind === "end" ? "end" : "continue" }),
				beforeIdle: async () => {
					idleCalls++;
				},
			},
			() => {},
			undefined,
			() => {
				providerCalls++;
				return response(exitKind === "end" ? "stop" : exitKind);
			},
		);
		expect(providerCalls).toBe(1);
		expect(idleCalls).toBe(0);
	});
});
