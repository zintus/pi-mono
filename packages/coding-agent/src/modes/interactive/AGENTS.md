# modes/interactive — TUI mode

`interactive-mode.ts` (~5k lines, one class `InteractiveMode`) is the terminal UI. It subscribes to `AgentSession` events and drives pi-tui `Component`s.

## Top-level layout (render order, top → bottom)

| Container | Purpose |
|-----------|---------|
| `chatContainer` | All messages, tool executions, borders, compaction summaries |
| `statusContainer` | Transient status rows — spinners and loaders (`loadingAnimation`, `autoCompactionLoader`, `retryLoader`) |
| `editorContainer` | Active editor (`defaultEditor`, or swapped for selectors/`BorderedLoader`) |
| `footer` | `FooterComponent` — model, thinking, token stats, extension status keys |

Built once in the constructor (~line 316); event handlers mutate `chatContainer`/`statusContainer` children rather than rebuilding.

## Event → UI mapping (`handleAgentEvent`, ~line 2558)

| Event | UI effect |
|-------|-----------|
| `agent_start` | Stops any prior `retryLoader`/`loadingAnimation`, creates fresh `loadingAnimation` with `defaultWorkingMessage`, applies any `pendingWorkingMessage` queued earlier |
| `message_start/update/end` | Creates/updates `AssistantMessageComponent` (streaming) or appends user/custom message components. Tool calls inside assistant messages materialize `ToolExecutionComponent` into `pendingTools` map keyed by `toolCallId` |
| `tool_execution_start/update/end` | Flags execution start, streams partial results, finalizes result on end, deletes from `pendingTools` |
| `agent_end` | **Only place** `loadingAnimation` stops in the normal path. Clears `statusContainer`, drops any still-streaming component, clears `pendingTools`, runs shutdown check |
| `compaction_start/end` | Swaps editor escape handler and shows `autoCompactionLoader` |
| `auto_retry_start/end` | Shows countdown-driven `retryLoader` with user escape to cancel |

## Spinner lifecycle gotcha (fork-specific)

The `loadingAnimation` "Working…" spinner is tied to `agent_start`/`agent_end`. The fork's `acquireHold()` (see `packages/agent/src/AGENTS.md`) blocks the loop before `agent_end` fires, so a backgrounded bash from `enhanced-bash.ts` leaves the spinner up until the bg process finishes — even though the model has already settled. If you add a new UI signal for "model idle but loop held", hook `turn_end`/`message_end` here; `agent_end` is the wrong anchor.

## Extension status line

`ctx.ui.setStatus(key, text)` from extensions flows through `setExtensionStatus` (~line 1874) into `footerDataProvider`, rendered as keyed segments in the footer. The spinner message can also be set via `setWorkingMessage` (queued in `pendingWorkingMessage` if fired before `agent_start`).

## Selectors and modal editors

Components in `components/` (model, theme, session, scoped-models, tree, user-message, extension, thinking, settings, config, login, oauth, show-images) replace `defaultEditor` in `editorContainer`. Pattern: save current focus, swap editor, restore on close. Search for `setFocus` + `editorContainer.addChild` for examples.

## Debugging

- **Spinner stuck on "Working…"**: check whether `agent_end` was emitted. Likely cause: outstanding `acquireHold` from an extension.
- **Missing tool output**: `pendingTools` is keyed by `toolCallId`. If `message_update` fires before the tool appears in the assistant content, nothing renders. Look for race with `tool_execution_start`.
- **Terminal test harness**: see root `pi-mono/AGENTS.md` § "Testing pi Interactive Mode with tmux".

## Research pointers

- Event types: `packages/agent/src/types.ts` (`AgentEvent` union)
- Session-side emission: `packages/coding-agent/src/core/agent-session.ts`
- Footer data: `packages/coding-agent/src/core/footer-data-provider.ts`
- pi-tui primitives (`Container`, `Loader`, `BorderedLoader`): `packages/tui/`
