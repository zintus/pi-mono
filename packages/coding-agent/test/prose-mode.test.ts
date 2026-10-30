import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Container,
	Image,
	resetCapabilitiesCache,
	setCapabilities,
	setKeybindings,
	Text,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ToolRenderers } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { keyHint } from "../src/modes/interactive/components/keybinding-hints.ts";
import { type WorkingProgress, WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		timestamp: 0,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function text(component: { render(width: number): string[] }, width = 100): string {
	return stripAnsi(component.render(width).join("\n"));
}

function tool(renderers?: ToolRenderers, toolName = "codemode"): ToolExecutionComponent {
	return new ToolExecutionComponent(
		toolName,
		"call",
		{ code: 'text("script output");' },
		{},
		renderers,
		{ requestRender: vi.fn() } as unknown as TUI,
		"/tmp",
	);
}

beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
	vi.setSystemTime(0);
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	vi.useRealTimers();
	resetCapabilitiesCache();
});

describe("prose-only components", () => {
	test.each([false, true])("hides thinking without placeholders and restores collapse state (hidden=%s)", (hidden) => {
		const message = assistant([
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "The builds passed." },
			{ type: "thinking", thinking: "another thought" },
		]);
		const snapshot = structuredClone(message);
		const component = new AssistantMessageComponent(message, hidden);
		const before = component.render(100);
		component.setProseOnly(true);
		expect(text(component).trim()).toBe("The builds passed.");
		component.invalidate();
		expect(text(component).trim()).toBe("The builds passed.");
		component.setProseOnly(false);
		expect(component.render(100)).toEqual(before);
		expect(message).toEqual(snapshot);
	});

	test("thinking-only and tool-only messages occupy no space, including while streaming", () => {
		const component = new AssistantMessageComponent();
		component.setProseOnly(true);
		const message = assistant(
			[
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "call", name: "read", arguments: {} },
			],
			"toolUse",
		);
		component.updateContent(message, true);
		expect(component.render(80)).toEqual([]);
		component.updateContent({ ...message, content: [...message.content, { type: "text", text: "Update" }] }, true);
		expect(text(component).trim()).toBe("Update");
	});

	test.each(["length", "error", "aborted"] as const)("keeps %s notices visible", (reason) => {
		const component = new AssistantMessageComponent(assistant([{ type: "thinking", thinking: "reasoning" }], reason));
		component.setProseOnly(true);
		expect(text(component)).not.toContain("reasoning");
		expect(text(component).trim()).toMatch(/truncated|Error:|Operation aborted/);
	});

	test.each([
		{ label: "fallback", renderers: undefined },
		{ label: "registered tool", renderers: {} },
		{ label: "codemode", renderers: codemodeRenderers },
		{
			label: "self-rendered extension",
			renderers: { renderShell: "self", renderCall: () => new Text("custom tool") },
		},
	] satisfies { label: string; renderers: ToolRenderers | undefined }[])(
		"hides entire $label codemode rows including failures and preserves live state",
		({ renderers }) => {
			const component = tool(renderers);
			component.setExpanded(true);
			component.setProseOnly(true);
			expect(component.render(80)).toEqual([]);
			component.updateResult({ content: [{ type: "text", text: "partial output" }], isError: false }, true);
			expect(component.render(80)).toEqual([]);
			const result = { content: [{ type: "text", text: "completed output" }], isError: false };
			const snapshot = structuredClone(result);
			component.updateResult(result);
			component.invalidate();
			expect(component.render(80)).toEqual([]);
			component.setProseOnly(false);
			const restored = component.render(80);
			expect(text(component)).toContain("completed output");
			component.setProseOnly(true);
			component.setProseOnly(false);
			expect(component.render(80)).toEqual(restored);
			expect(result).toEqual(snapshot);
			component.setProseOnly(true);
			component.updateResult({ content: [{ type: "text", text: "permission denied" }], isError: true });
			expect(component.render(80)).toEqual([]);
			expect(text(component)).not.toContain("permission denied");
			component.setProseOnly(false);
			expect(text(component)).toContain("permission denied");
		},
	);

	test.each([false, true])(
		"failed codemode hides scripts, nested calls, output and images (expanded=%s)",
		(expanded) => {
			setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
			const imageRender = vi.spyOn(Image.prototype, "render").mockReturnValue(["tool image"]);
			try {
				const component = tool(codemodeRenderers);
				component.setExpanded(expanded);
				component.setProseOnly(true);
				component.markExecutionStarted();
				const result = {
					content: [
						{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
						{ type: "text", text: "large partial output\nScript error: command failed" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
					isError: true,
					details: {
						calls: [
							{ name: "read", args: '{"path":"notes.txt"}', status: "ok", durationMs: 3 },
							{ name: "bash", args: '{"command":"false"}', status: "error", durationMs: 85, error: "exit 1" },
						],
						fullOutputPath: "/tmp/codemode-output.txt",
					},
				};
				const snapshot = structuredClone(result);
				component.updateResult({ ...result, isError: false }, true);
				expect(component.render(100)).toEqual([]);
				component.updateResult(result);
				component.invalidate();
				for (const width of [10, 40, 100]) expect(component.render(width)).toEqual([]);
				expect(imageRender).not.toHaveBeenCalled();
				component.setProseOnly(false);
				const normal = component.render(100);
				expect(text(component)).toContain('text("script output");');
				expect(text(component)).toContain('"command":"false"');
				expect(text(component)).toContain("large partial output");
				expect(imageRender).toHaveBeenCalled();
				component.setProseOnly(true);
				expect(component.render(100)).toEqual([]);
				component.setProseOnly(false);
				expect(component.render(100)).toEqual(normal);
				expect(result).toEqual(snapshot);
			} finally {
				imageRender.mockRestore();
			}
		},
	);

	test.each([false, true])("failed WaitForBash occupies no rows and restores details (expanded=%s)", (expanded) => {
		const component = tool(undefined, "WaitForBash");
		component.setExpanded(expanded);
		component.setProseOnly(true);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial output" }], isError: false }, true);
		expect(component.render(100)).toEqual([]);
		const result = { content: [{ type: "text", text: "Background bash completed; exit code 1." }], isError: true };
		const snapshot = structuredClone(result);
		component.updateResult(result);
		component.invalidate();
		expect(component.render(100)).toEqual([]);
		component.setProseOnly(false);
		const normal = component.render(100);
		expect(text(component)).toContain("Background bash completed; exit code 1.");
		component.setProseOnly(true);
		expect(component.render(100)).toEqual([]);
		component.setProseOnly(false);
		expect(component.render(100)).toEqual(normal);
		expect(result).toEqual(snapshot);
	});

	test("other failure notices use the configured prose shortcut", () => {
		setKeybindings(new KeybindingsManager({ "app.transcript.prose": "ctrl+alt+o" }));
		const component = tool(undefined, "read");
		component.updateResult({ content: [], isError: true });
		component.setProseOnly(true);
		expect(text(component).trim()).toBe(
			`read failed · ${stripAnsi(keyHint("app.transcript.prose", "to show details"))}`,
		);
	});

	test.each([false, true])("hidden tool details cannot receive clicks (isError=%s)", (isError) => {
		const component = tool();
		component.updateResult({ content: [{ type: "text", text: "output" }], isError });
		component.render(80);
		component.setProseOnly(true);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: 2,
			screenX: 1,
			screenY: 2,
			width: 80,
			height: 10,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)).toBeUndefined();
	});
});

function context(proseOnly = false) {
	const keybindings = new KeybindingsManager();
	const renderer = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: false,
		terminal: new VirtualTerminal(100, 24),
		logDirectory: "/tmp",
	});
	const editor = new CustomEditor(renderer, getEditorTheme(), keybindings, { embedWorkingStatus: true });
	const state = {
		proseOnly,
		toolOutputExpanded: false,
		hideThinkingBlock: true,
		outputPad: 1,
		workingProgress: undefined as WorkingProgress | undefined,
		activeStatusIndicator: undefined as WorkingStatusIndicator | undefined,
		workingVisible: true,
		defaultWorkingMessage: "Working",
		isInitialized: true,
		chatContainer: new Container(),
		loadedResourcesContainer: new Container(),
		statusContainer: new Container(),
		editorContainer: new Container(),
		extensionDialogs: [],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		streamingComponent: undefined as AssistantMessageComponent | undefined,
		streamingMessage: undefined as AssistantMessage | undefined,
		ui: renderer,
		renderer,
		editor,
		defaultEditor: editor,
		keybindings,
		footer: { invalidate: vi.fn(), setProseOnly: vi.fn() },
		programStatus: { handleEvent: vi.fn(), setBlocked: vi.fn() },
		session: { retryAttempt: 0 },
		sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
		settingsManager: {
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowTerminalProgress: () => false,
			setHideThinkingBlock: vi.fn(),
		},
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => ({}),
		updateEditorBorderColor: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		maybeShowInstallChangeWarning: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
		checkShutdownRequested: vi.fn(),
		disposeActiveSelector: vi.fn(),
		options: { tuiMode: "fullscreen" },
	};
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	type Methods = {
		toggleProseOnly(): void;
		setupKeyHandlers(): void;
		handleEvent(event: AgentSessionEvent): Promise<void>;
		renderSessionItems(items: AgentMessage[]): void;
		renderSessionEntries(entries: SessionEntry[]): void;
		showExtensionConfirm(title: string, message: string): Promise<boolean>;
		clearStatusIndicator(): void;
	};
	return new Proxy(state, {
		get(target, key, receiver) {
			if (key in target) return Reflect.get(target, key, receiver);
			const value = prototype[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	}) as typeof state & Methods;
}

const call = { type: "toolCall", id: "call", name: "read", arguments: { path: "notes.txt" } } as const;
const start: AgentSessionEvent = {
	type: "tool_execution_start",
	toolCallId: "call",
	toolName: "read",
	args: call.arguments,
};
const end: AgentSessionEvent = {
	type: "tool_execution_end",
	toolCallId: "call",
	toolName: "read",
	result: { content: [{ type: "text", text: "tool output" }], details: undefined },
	isError: false,
};

describe("prose-only startup setting", () => {
	test("schema and runtime default to prose, and require a boolean when configured", () => {
		const validator = Compile(SettingsSchema);
		expect(SettingsSchema.properties.proseOnly).toMatchObject({ default: true });
		expect(SettingsManager.inMemory().getProseOnly()).toBe(true);
		for (const proseOnly of [false, true]) {
			expect(validator.Check({ proseOnly })).toBe(true);
			expect(SettingsManager.inMemory({ proseOnly }).getProseOnly()).toBe(proseOnly);
		}
		for (const proseOnly of ["yes", "false", 1, null]) {
			expect(validator.Check({ proseOnly })).toBe(false);
		}
	});

	test.each([false, true])("trusted project settings override global proseOnly=%s", (proseOnly) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ proseOnly }));
		storage.withLock("project", () => JSON.stringify({ proseOnly: !proseOnly }));
		expect(SettingsManager.fromStorage(storage).getProseOnly()).toBe(!proseOnly);
		expect(SettingsManager.fromStorage(storage, { projectTrusted: false }).getProseOnly()).toBe(proseOnly);
	});

	test.each([undefined, false, true])(
		"initializes transcript and footer from proseOnly=%s without saving toggles",
		(proseOnly) => {
			const settingsManager = SettingsManager.inMemory({ proseOnly, hideThinkingBlock: false, theme: "dark" });
			const snapshot = settingsManager.getSettings();
			const runtime = {
				session: {
					settingsManager,
					sessionManager: SessionManager.inMemory("/tmp"),
					resourceLoader: { getThemes: () => ({ themes: [] }) },
					extensionRunner: { getMarkdownTransformers: () => [], resolveToolRenderers: () => undefined },
					getContextUsage: () => undefined,
					state: {},
					autoCompactionEnabled: true,
				},
				setBeforeSessionInvalidate: vi.fn(),
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime;
			const keybindings = vi.spyOn(KeybindingsManager, "create").mockReturnValue(new KeybindingsManager());
			const mode = new InteractiveMode(runtime, { terminal: new VirtualTerminal(100, 24) });
			const view = mode as unknown as {
				chatContainer: Container;
				footer: { render(width: number): string[] };
				defaultEditor: CustomEditor;
				setupKeyHandlers(): void;
				renderSessionItems(items: AgentMessage[]): void;
			};
			try {
				view.renderSessionItems([
					assistant(
						[{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "Summary" }, call],
						"toolUse",
					),
				]);
				const enabled = proseOnly ?? true;
				expect(text(view.chatContainer)).toContain("Summary");
				expect(text(view.chatContainer).includes("reasoning")).toBe(!enabled);
				expect(text(view.chatContainer).includes("notes.txt")).toBe(!enabled);
				expect(text(view.footer).includes("prose only")).toBe(enabled);
				view.setupKeyHandlers();
				view.defaultEditor.handleInput("\x1bo");
				expect(text(view.chatContainer).includes("reasoning")).toBe(enabled);
				expect(text(view.chatContainer).includes("notes.txt")).toBe(enabled);
				expect(text(view.footer).includes("prose only")).toBe(!enabled);
				expect(settingsManager.getSettings()).toEqual(snapshot);
			} finally {
				mode.stop();
				keybindings.mockRestore();
			}
		},
	);
});

describe("prose-only interactive wiring", () => {
	test("Alt+O toggles existing content without losing tool identity or changing normal collapse settings", () => {
		const ctx = context();
		ctx.renderSessionItems([
			{ role: "user", content: "Please check", timestamp: 0 },
			assistant([{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "Checking." }, call], "toolUse"),
		]);
		const pending = ctx.pendingTools.get("call");
		ctx.setupKeyHandlers();
		ctx.editor.setText("unfinished draft");
		ctx.editor.handleInput("\x1bo");
		expect(ctx.proseOnly).toBe(true);
		expect(text(ctx.chatContainer)).toContain("Please check");
		expect(text(ctx.chatContainer)).toContain("Checking.");
		expect(text(ctx.chatContainer)).not.toContain("Thinking...");
		expect(text(ctx.chatContainer)).not.toContain("notes.txt");
		expect(ctx.pendingTools.get("call")).toBe(pending);
		expect(ctx.editor.getText()).toBe("unfinished draft");
		expect(ctx.toolOutputExpanded).toBe(false);
		expect(ctx.hideThinkingBlock).toBe(true);
		expect(ctx.settingsManager.setHideThinkingBlock).not.toHaveBeenCalled();
		ctx.editor.handleInput("\x1bo");
		expect(text(ctx.chatContainer)).toContain("Thinking...");
		expect(text(ctx.chatContainer)).toContain("notes.txt");
		expect(ctx.footer.setProseOnly.mock.calls).toEqual([[true], [false]]);
	});

	test("the action can be rebound independently of Ctrl+O", () => {
		const ctx = context();
		ctx.keybindings.setUserBindings({ "app.transcript.prose": "ctrl+alt+o" });
		ctx.setupKeyHandlers();
		ctx.editor.handleInput("\x1b[111;7u");
		expect(ctx.proseOnly).toBe(true);
		ctx.editor.handleInput("\x0f");
		expect(ctx.toolOutputExpanded).toBe(true);
		expect(ctx.proseOnly).toBe(true);
	});

	test("prose shortcuts are reserved against extensions, including rebound keys", async () => {
		const eventBus = createEventBus();
		const runtime = createExtensionRuntime(eventBus);
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerShortcut("alt+o", { handler: () => {} });
				pi.registerShortcut("ctrl+alt+o", { handler: () => {} });
			},
			"/tmp",
			eventBus,
			runtime,
		);
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([extension], runtime, "/tmp", SessionManager.inMemory(), registry);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const keybindings = new KeybindingsManager();
			expect(runner.getShortcuts(keybindings.getEffectiveConfig()).has("alt+o")).toBe(false);
			keybindings.setUserBindings({ "app.transcript.prose": "ctrl+alt+o" });
			const shortcuts = runner.getShortcuts(keybindings.getEffectiveConfig());
			expect(shortcuts.has("ctrl+alt+o")).toBe(false);
			expect(shortcuts.has("alt+o")).toBe(true);
		} finally {
			warning.mockRestore();
		}
	});

	test.each(
		[false, true].flatMap((isError) =>
			["read", "WaitForBash", "codemode"].map((toolName) => ({ isError, toolName })),
		),
	)(
		"historical/rebuilt $toolName entries inherit prose mode without modifying saved messages (isError=$isError)",
		({ isError, toolName }) => {
			const ctx = context(true);
			const entries: SessionEntry[] = [
				{
					type: "message",
					id: "a",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					message: assistant([
						{ type: "thinking", thinking: "reasoning" },
						{ type: "text", text: "Summary" },
						{ ...call, name: toolName },
					]),
				},
				{
					type: "message",
					id: "b",
					parentId: "a",
					timestamp: "2026-01-01T00:00:00Z",
					message: {
						role: "toolResult",
						toolCallId: "call",
						toolName,
						content: [{ type: "text", text: "result" }],
						isError,
						timestamp: 0,
					},
				},
			];
			const snapshot = structuredClone(entries);
			ctx.renderSessionEntries(entries);
			const rendered = text(ctx.chatContainer);
			expect(rendered).toContain("Summary");
			expect(rendered).not.toContain("result");
			if (isError && toolName === "read") expect(rendered).toContain("read failed");
			else expect(rendered.trim()).toBe("Summary");
			ctx.chatContainer.clear();
			ctx.renderSessionEntries(entries);
			expect(text(ctx.chatContainer)).toBe(rendered);
			ctx.toggleProseOnly();
			expect(text(ctx.chatContainer)).toContain("result");
			expect(entries).toEqual(snapshot);
			expect(ctx.workingProgress).toBeUndefined();
		},
	);

	test("streamed and direct tool starts stay hidden, update in place, and surface failures", async () => {
		const ctx = context(true);
		const message = assistant([{ type: "thinking", thinking: "reasoning" }]);
		await ctx.handleEvent({ type: "message_start", message });
		const update = assistant([...message.content, { type: "text", text: "Checking" }, call], "toolUse");
		await ctx.handleEvent({
			type: "message_update",
			message: update,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Checking", partial: update },
		});
		await ctx.handleEvent(start);
		await ctx.handleEvent({
			type: "tool_execution_update",
			toolCallId: "call",
			toolName: "read",
			args: call.arguments,
			partialResult: { content: [{ type: "text", text: "partial" }], details: undefined },
		});
		expect(text(ctx.chatContainer).trim()).toBe("Checking");
		const pending = ctx.pendingTools.get("call");
		ctx.toggleProseOnly();
		expect(text(ctx.chatContainer)).toContain("partial");
		ctx.toggleProseOnly();
		await ctx.handleEvent(end);
		expect(pending?.render(100)).toEqual([]);
		await ctx.handleEvent({ ...start, toolCallId: "direct" });
		expect(ctx.pendingTools.get("direct")?.render(100)).toEqual([]);
		await ctx.handleEvent({ ...end, toolCallId: "direct", isError: true });
		expect(text(ctx.chatContainer)).toContain("read failed");
		expect(text(ctx.chatContainer)).not.toContain("tool output");
		ctx.toggleProseOnly();
		expect(text(ctx.chatContainer)).not.toContain("partial");
		expect(text(ctx.chatContainer)).toContain("tool output");
	});

	test.each(["WaitForBash", "codemode"])(
		"live %s failures stay hidden until prose mode is disabled",
		async (toolName) => {
			const ctx = context(true);
			await ctx.handleEvent({ ...start, toolName });
			const pending = ctx.pendingTools.get("call");
			await ctx.handleEvent({ ...end, toolName, isError: true });
			expect(pending?.render(100)).toEqual([]);
			expect(text(ctx.chatContainer).trim()).toBe("");
			ctx.toggleProseOnly();
			expect(text(ctx.chatContainer)).toContain("tool output");
			ctx.toggleProseOnly();
			expect(pending?.render(100)).toEqual([]);
			expect(text(ctx.chatContainer).trim()).toBe("Prose-only mode: on");
		},
	);

	test("approval dialogs remain visible and answerable in prose mode", async () => {
		const ctx = context(true);
		const answer = ctx.showExtensionConfirm("Allow action?", "Approval required");
		expect(text(ctx.editorContainer)).toContain("Approval required");
		ctx.renderer.getFocusedComponent()?.handleInput?.("\r");
		await expect(answer).resolves.toBe(true);
	});

	test("streaming deltas do not refresh unchanged progress", async () => {
		const ctx = context(true);
		await ctx.handleEvent({ type: "agent_start" });
		await ctx.handleEvent({ type: "turn_start" });
		const refresh = vi.spyOn(ctx.activeStatusIndicator!, "setProgress");
		try {
			const message = assistant([{ type: "text", text: "Checking" }]);
			await ctx.handleEvent({ type: "message_start", message });
			await ctx.handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Checking", partial: message },
			});
			expect(refresh).not.toHaveBeenCalled();
			await ctx.handleEvent(start);
			expect(refresh).toHaveBeenCalledTimes(1);
			await ctx.handleEvent({ ...end, isError: true });
			expect(refresh).toHaveBeenCalledTimes(2);
			expect(text(ctx.editor)).toContain("1 tool call · 0s · 1 failed");
		} finally {
			ctx.clearStatusIndicator();
		}
	});

	test("counts execution starts including nested calls, retains totals over retries, and resets after settlement", async () => {
		const ctx = context();
		await ctx.handleEvent({ type: "agent_start" });
		await ctx.handleEvent({ type: "turn_start" });
		try {
			await ctx.handleEvent(start);
			await ctx.handleEvent({ ...start, toolCallId: "call/1", parentToolCallId: "call" });
			await ctx.handleEvent({ ...end, toolCallId: "call/1", parentToolCallId: "call", isError: true });
			expect(ctx.workingProgress).toEqual({ startedAt: 0, toolCalls: 2, failedCalls: 1 });
			expect(text(ctx.editor)).not.toContain("tool calls");
			vi.advanceTimersByTime(83_000);
			ctx.toggleProseOnly();
			expect(text(ctx.editor)).toContain("Working · 2 tool calls · 1m 23s · 1 failed");
			await ctx.handleEvent({ type: "agent_end", messages: [], willRetry: true });
			await ctx.handleEvent({ type: "agent_start" });
			await ctx.handleEvent({ type: "turn_start" });
			expect(text(ctx.editor)).toContain("2 tool calls · 1m 23s");
			await ctx.handleEvent({ type: "agent_end", messages: [], willRetry: false });
			await ctx.handleEvent({ type: "agent_settled", aborted: false });
			await ctx.handleEvent({ type: "agent_start" });
			expect(ctx.workingProgress).toEqual({ startedAt: 83_000, toolCalls: 0, failedCalls: 0 });
		} finally {
			ctx.clearStatusIndicator();
		}
	});
});

describe("prose progress indicator", () => {
	test("updates time with a static spinner, preserves custom labels, fits narrow borders, and cleans up timers", () => {
		const ui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(ui, "Working", { frames: ["*"] });
		const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
		editor.setWorkingStatusIndicator(indicator);
		indicator.setProgress({ startedAt: 0, toolCalls: 14, failedCalls: 0 });
		vi.advanceTimersByTime(83_000);
		expect(text(editor)).toContain("Working · 14 tool calls · 1m 23s");
		expect(text(editor)).not.toContain("failed");
		indicator.setMessage("Reviewing");
		expect(text(editor)).toContain("Reviewing · 14 tool calls");
		for (const width of [1, 4, 10, 20, 40, 80]) expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
		indicator.setProgress(undefined);
		expect(text(editor)).toContain("Reviewing");
		expect(text(editor)).not.toContain("tool calls");
		expect(vi.getTimerCount()).toBe(0);
		indicator.setProgress({ startedAt: 0, toolCalls: 1, failedCalls: 1 });
		expect(text(editor)).toContain("1 tool call · 1m 23s · 1 failed");
		indicator.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
