import { beforeEach, describe, expect, it, vi } from "vitest";

const timeoutMock = vi.hoisted(() => ({
	clientConfigs: [] as Array<Record<string, unknown>>,
	http1Configs: [] as Array<Record<string, unknown>>,
	http2Configs: [] as Array<Record<string, unknown>>,
	streamFactory: undefined as (() => AsyncIterable<unknown>) | undefined,
}));

vi.mock("@smithy/node-http-handler", () => {
	class NodeHttpHandler {
		constructor(config: Record<string, unknown> = {}) {
			timeoutMock.http1Configs.push(config);
		}
	}

	class NodeHttp2Handler {
		constructor(config: Record<string, unknown> = {}) {
			timeoutMock.http2Configs.push(config);
		}
	}

	return { NodeHttpHandler, NodeHttp2Handler };
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			timeoutMock.clientConfigs.push(config);
		}

		send(): Promise<unknown> {
			if (timeoutMock.streamFactory) {
				return Promise.resolve({
					$metadata: { httpStatusCode: 200 },
					stream: timeoutMock.streamFactory(),
				});
			}
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-opus-4-8",
	name: "Claude Opus",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

async function drive(options: BedrockOptions): Promise<void> {
	await streamBedrock(model, context, {
		cacheRetention: "none",
		env: { NO_PROXY: "*" },
		...options,
	})
		.result()
		.catch(() => undefined);
}

beforeEach(() => {
	timeoutMock.clientConfigs.length = 0;
	timeoutMock.http1Configs.length = 0;
	timeoutMock.http2Configs.length = 0;
	timeoutMock.streamFactory = undefined;
});

describe("Bedrock timeout forwarding", () => {
	it("uses timeoutMs as the HTTP/2 stream-idle timeout", async () => {
		await drive({ timeoutMs: 300_000 });

		expect(timeoutMock.http2Configs).toEqual([{ requestTimeout: 300_000 }]);
		expect(timeoutMock.http1Configs).toHaveLength(0);
		expect(timeoutMock.clientConfigs[0]?.requestHandler).toBeDefined();
	});

	it("uses timeoutMs as the forced HTTP/1.1 socket-idle timeout", async () => {
		await drive({ timeoutMs: 300_000, env: { NO_PROXY: "*", AWS_BEDROCK_FORCE_HTTP1: "1" } });

		expect(timeoutMock.http1Configs).toEqual([{ socketTimeout: 300_000 }]);
		expect(timeoutMock.http2Configs).toHaveLength(0);
		expect(timeoutMock.clientConfigs[0]?.requestHandler).toBeDefined();
	});

	it("times out when an established ConverseStream stalls between events", async () => {
		timeoutMock.streamFactory = async function* () {
			yield { messageStart: { role: "assistant" } };
			await new Promise<never>(() => undefined);
		};

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			env: { NO_PROXY: "*" },
			timeoutMs: 20,
		})
			.result()
			.catch((error) => error as { errorMessage?: string });

		expect(result.errorMessage).toContain("Bedrock stream timed out after 20ms without activity");
	});

	it("resets the timeout after every ConverseStream event", async () => {
		timeoutMock.streamFactory = async function* () {
			yield { messageStart: { role: "assistant" } };
			await new Promise((resolve) => setTimeout(resolve, 20));
			yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
			await new Promise((resolve) => setTimeout(resolve, 20));
			yield { messageStop: { stopReason: "end_turn" } };
		};

		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			env: { NO_PROXY: "*" },
			timeoutMs: 35,
		}).result();

		expect(result.stopReason).toBe("stop");
	});

	it("preserves the SDK default handler when timeoutMs is absent", async () => {
		await drive({});

		expect(timeoutMock.http1Configs).toHaveLength(0);
		expect(timeoutMock.http2Configs).toHaveLength(0);
		expect(timeoutMock.clientConfigs[0]?.requestHandler).toBeUndefined();
	});

	it("accepts zero as an explicit disabled timeout", async () => {
		await drive({ timeoutMs: 0 });

		expect(timeoutMock.http2Configs).toEqual([{ requestTimeout: 0 }]);
	});

	it("rejects invalid timeout values before creating a client", () => {
		expect(() =>
			streamBedrock(model, context, {
				cacheRetention: "none",
				env: { NO_PROXY: "*" },
				timeoutMs: -1,
			}),
		).toThrow("Invalid timeoutMs: -1");

		expect(timeoutMock.clientConfigs).toHaveLength(0);
		expect(timeoutMock.http1Configs).toHaveLength(0);
		expect(timeoutMock.http2Configs).toHaveLength(0);
	});
});
