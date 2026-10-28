import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

/**
 * Fork regression: an automatic start (`pi.sendMessage(..., { triggerTurn: true })` from an
 * `agent_settled` handler) is deferred until every settled handler ran, behind prompts deferred
 * before it. It must not start a run after the user aborted one of those, and one failing
 * deferred action must not abandon the ones after it.
 */
describe("deferred automatic starts after settlement", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function waitTool(): { tool: AgentTool; executing: Promise<void>; release: () => void } {
		let release = () => {};
		let executing = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const executingPromise = new Promise<void>((resolve) => {
			executing = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until released",
			parameters: Type.Object({}),
			execute: async () => {
				executing();
				await released;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		return { tool, executing: executingPromise, release };
	}

	it("delivers the message with the next run when the user aborts a prompt deferred before it", async () => {
		const wait = waitTool();
		let harness!: Harness;
		let deferredPrompt = false;
		let sentNotice = false;
		harness = await createHarness({
			tools: [wait.tool],
			extensionFactories: [
				(pi) => {
					// A prompt typed while settlement handlers run is deferred ahead of the notice.
					pi.on("agent_settled", () => {
						if (deferredPrompt) return;
						deferredPrompt = true;
						void harness.session.prompt("typed during settlement");
					});
				},
				(pi) => {
					pi.on("agent_settled", () => {
						if (sentNotice) return;
						sentNotice = true;
						pi.sendMessage(
							{ customType: "job-done", content: "job finished", display: true },
							{ triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		]);

		const first = harness.session.prompt("start");
		await wait.executing;
		const aborting = harness.session.abort();
		wait.release();
		await aborting;
		await first;

		// The aborted prompt's run was the last one: the notice did not start a third run.
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled").map((event) => event.aborted)).toEqual([false, true]);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);
		// Not a queue entry (Escape clears those): it goes with the next run's starting messages.
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		harness.session.clearQueue();

		// The next run carries it, so its message_end still arrives.
		harness.setResponses([fauxAssistantMessage("saw the notice")]);
		await harness.session.prompt("next");
		const tail = harness.session.messages.slice(-3).map((message) => `${message.role}:${getMessageText(message)}`);
		expect(tail).toEqual(["user:next", "custom:job finished", "assistant:saw the notice"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(3);
	});

	for (const when of ["before", "after"] as const) {
		it(`withdraws the start when abort() is called during settlement ${when} the sender's handler`, async () => {
			let harness!: Harness;
			let sentNotice = false;
			let stopped = false;
			const stop = () => {
				if (stopped) return;
				stopped = true;
				void harness.session.abort();
			};
			harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("agent_settled", () => {
							if (when === "before") stop();
						});
					},
					(pi) => {
						pi.on("agent_settled", () => {
							if (sentNotice) return;
							sentNotice = true;
							pi.sendMessage(
								{ customType: "job-done", content: "job finished", display: true },
								{ triggerTurn: true },
							);
						});
					},
					(pi) => {
						pi.on("agent_settled", () => {
							if (when === "after") stop();
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("first")]);

			await harness.session.prompt("start");

			// The stop during settlement withdrew the automatic start.
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
			expect(harness.session.isIdle).toBe(true);
			expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);

			harness.setResponses([fauxAssistantMessage("saw the notice")]);
			await harness.session.prompt("next");
			const tail = harness.session.messages.slice(-3).map((message) => `${message.role}:${getMessageText(message)}`);
			expect(tail).toEqual(["user:next", "custom:job finished", "assistant:saw the notice"]);
		});
	}

	it("does not deliver a message twice when its start fails after the message entered the context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		// No model: the run starts (the message is in the context) and fails on the request.
		(harness.session.agent.state as { model: unknown }).model = undefined;

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "job-done", content: "job finished", display: true },
				{ triggerTurn: true },
			),
		).rejects.toThrow();
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(1);

		(harness.session.agent.state as { model: unknown }).model = model;
		harness.setResponses([fauxAssistantMessage("saw the notice")]);
		await harness.session.prompt("next");
		expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(1);
		const tail = harness.session.messages.slice(-3).map((message) => `${message.role}:${getMessageText(message)}`);
		expect(tail).toEqual(["custom:job finished", "user:next", "assistant:saw the notice"]);
	});

	it("keeps a withdrawn message for the next run when the following run fails to prepare", async () => {
		let harness!: Harness;
		let sentNotice = false;
		let stopped = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (sentNotice) return;
						sentNotice = true;
						pi.sendMessage(
							{ customType: "job-done", content: "job finished", display: true },
							{ triggerTurn: true },
						);
						if (!stopped) {
							stopped = true;
							void harness.session.abort();
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("start");
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);

		// The next prompt takes the pending message but fails while preparing its loadout.
		const prepare = vi
			.spyOn(
				harness.session as unknown as { _preparePromptAndToolLoadout: () => unknown },
				"_preparePromptAndToolLoadout",
			)
			.mockImplementationOnce(() => {
				throw new Error("loadout failed");
			});
		await expect(harness.session.prompt("broken")).rejects.toThrow("loadout failed");
		prepare.mockRestore();
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);

		harness.setResponses([fauxAssistantMessage("saw the notice")]);
		await harness.session.prompt("next");
		const tail = harness.session.messages.slice(-3).map((message) => `${message.role}:${getMessageText(message)}`);
		expect(tail).toEqual(["user:next", "custom:job finished", "assistant:saw the notice"]);
	});

	it("does not redeliver a delivered message when its run fails late, after the context was rebuilt", async () => {
		let harness!: Harness;
		let sentNotice = false;
		let annotated = false;
		let failedOnce = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("noop", { description: "no-op", handler: async () => {} });
					pi.on("agent_settled", () => {
						if (sentNotice) return;
						sentNotice = true;
						pi.sendMessage(
							{ customType: "job-done", content: "job finished", display: true },
							{ triggerTurn: true },
						);
					});
					pi.on("turn_end", () => {
						// An annotation appended at the notice run's turn boundary rebuilds the
						// context from the session, replacing the notice's object.
						if (!sentNotice || annotated) return;
						annotated = true;
						pi.sendMessage({ customType: "annotation", content: "note", display: false });
					});
					pi.on("agent_settled", () => {
						// A later deferred action of the notice run's own settlement fails.
						if (!annotated || failedOnce) return;
						failedOnce = true;
						harness.session
							.prompt("/noop", {
								preflightResult: () => {
									throw new Error("preflight failed");
								},
							})
							.catch(() => undefined);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("saw the notice")]);

		await expect(harness.session.prompt("start")).rejects.toThrow("preflight failed");
		expect(harness.session.isIdle).toBe(true);
		const notices = () =>
			harness.session.messages.filter((message) => message.role === "custom" && message.customType === "job-done");
		expect(notices()).toHaveLength(1);

		harness.setResponses([fauxAssistantMessage("later")]);
		await harness.session.prompt("next");
		expect(notices()).toHaveLength(1);
	});

	it("starts normally when nothing was aborted in between", async () => {
		let harness!: Harness;
		let deferredPrompt = false;
		let sentNotice = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						if (deferredPrompt) return;
						deferredPrompt = true;
						void harness.session.prompt("typed during settlement");
					});
				},
				(pi) => {
					pi.on("agent_settled", () => {
						if (sentNotice) return;
						sentNotice = true;
						pi.sendMessage(
							{ customType: "job-done", content: "job finished", display: true },
							{ triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("saw the notice"),
		]);

		await harness.session.prompt("start");

		expect(harness.eventsOfType("agent_start")).toHaveLength(3);
		const roles = harness.session.messages
			.filter((message) => message.role !== "system")
			.map((message) => `${message.role}:${getMessageText(message)}`);
		expect(roles).toEqual([
			"user:start",
			"assistant:first",
			"user:typed during settlement",
			"assistant:second",
			"custom:job finished",
			"assistant:saw the notice",
		]);
	});

	it("runs the deferred actions after one that fails", async () => {
		let harness!: Harness;
		let deferredPrompt = false;
		let sentNotice = false;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("noop", { description: "no-op", handler: async () => {} });
					pi.on("agent_settled", () => {
						if (deferredPrompt) return;
						deferredPrompt = true;
						// The replayed prompt is handled as a command; its preflight callback throws.
						harness.session
							.prompt("/noop", {
								preflightResult: () => {
									throw new Error("preflight failed");
								},
							})
							.catch(() => undefined);
					});
				},
				(pi) => {
					pi.on("agent_settled", () => {
						if (sentNotice) return;
						sentNotice = true;
						pi.sendMessage(
							{ customType: "job-done", content: "job finished", display: true },
							{ triggerTurn: true },
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("saw the notice")]);

		// The failure surfaces to the caller of the run that settled, after every action ran.
		await expect(harness.session.prompt("start")).rejects.toThrow("preflight failed");

		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.session.messages.slice(-2).map((message) => `${message.role}:${getMessageText(message)}`)).toEqual(
			["custom:job finished", "assistant:saw the notice"],
		);
	});
});
