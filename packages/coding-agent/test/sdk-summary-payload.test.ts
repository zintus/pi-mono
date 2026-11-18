import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	lazyStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader, userMsg } from "./utilities.ts";

const model: Model<"openai-responses"> = {
	id: "capture-model",
	name: "Capture Model",
	api: "openai-responses",
	provider: "capture-provider",
	baseUrl: "https://capture.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
};

function reply(inputTokens = 10): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "summary or reply" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: inputTokens,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("SDK summary provider payload hooks", () => {
	const sessions: AgentSession[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createFixture(mode: "enabled" | "disabled" | "excluded" = "enabled") {
		const cwd = mkdtempSync(join(tmpdir(), "pi-sdk-summary-payload-"));
		dirs.push(cwd);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "test-api-key" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const payloads: unknown[] = [];
		const requestOptions: SimpleStreamOptions[] = [];
		modelRuntime.registerProvider(model.provider, {
			api: model.api,
			models: [model],
			streamSimple: (requestModel, context, options) =>
				lazyStream(requestModel, async () => {
					const payload = { model: requestModel.id, input: context.messages };
					payloads.push((await options?.onPayload?.(payload, requestModel)) ?? payload);
					requestOptions.push(options ?? {});
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message: reply() });
					return stream;
				}),
		});
		const hook = vi.fn((payload: unknown) => ({
			...(payload as Record<string, unknown>),
			service_tier: "ultrafast",
		}));
		const compactions: string[] = [];
		const enabled = mode !== "disabled";
		const allowedModels = mode === "excluded" ? [] : [model.id];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("before_provider_request", (event, ctx) => {
					if (enabled && allowedModels.includes(ctx.model?.id ?? "")) return hook(event.payload);
				});
				pi.on("session_before_compact", (event) => {
					compactions.push(event.reason);
				});
			},
		]);
		const sessionManager = SessionManager.inMemory(cwd);
		const targetId = sessionManager.appendMessage(userMsg("first branch"));
		sessionManager.appendMessage(reply());
		sessionManager.appendMessage(userMsg("old history ".repeat(2000)));
		sessionManager.appendMessage(reply(6000));
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			model,
			modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 30000 },
			}),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			tools: [],
		});
		sessions.push(session);
		return { session, sessionManager, targetId, payloads, requestOptions, hook, compactions };
	}

	for (const operation of ["manual", "automatic", "branch"] as const) {
		it.each(["enabled", "disabled", "excluded"] as const)(
			`${operation} summary respects %s payload policy`,
			async (mode) => {
				const fixture = await createFixture(mode);
				if (operation === "branch") {
					const result = await fixture.session.navigateTree(fixture.targetId, { summarize: true });
					expect(result.summaryEntry?.summary).toContain("summary or reply");
				} else if (operation === "manual") {
					const result = await fixture.session.compact();
					expect(result.summary).toContain("summary or reply");
					expect(fixture.compactions).toEqual(["manual"]);
				} else {
					await fixture.session.prompt("continue");
					expect(fixture.compactions).toEqual(["threshold"]);
					expect(fixture.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
				}

				expect(fixture.payloads.length).toBeGreaterThan(0);
				expect(fixture.requestOptions[0].cacheRetention).toBe("none");
				expect(fixture.requestOptions[0].sessionId).not.toBe(fixture.session.sessionId);
				for (const payload of fixture.payloads) {
					if (mode === "enabled") expect(payload).toHaveProperty("service_tier", "ultrafast");
					else expect(payload).not.toHaveProperty("service_tier");
				}
				expect(fixture.hook).toHaveBeenCalledTimes(mode === "enabled" ? fixture.payloads.length : 0);
			},
		);
	}

	it("preserves an explicit request payload callback instead of running it twice", async () => {
		const fixture = await createFixture();
		const onPayload = vi.fn(() => ({ model: model.id, service_tier: "explicit" }));
		const stream = await fixture.session.agent.streamFunction(model, normalizeContext({ messages: [] }), {
			onPayload,
		});
		await stream.result();

		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(fixture.hook).not.toHaveBeenCalled();
		expect(fixture.payloads).toEqual([{ model: model.id, service_tier: "explicit" }]);
	});
});
