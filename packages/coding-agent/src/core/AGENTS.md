# src/core — AgentSession and Supporting Infrastructure

## Key Files

| File | Lines | Purpose |
|------|------:|---------|
| `agent-session.ts` | 3072 | `AgentSession` — the main orchestrator. Owns the `Agent`, extensions, tools, event routing, steering/follow-up queuing, compaction. Everything flows through here. |
| `session-manager.ts` | 1420 | `SessionManager` — persistence layer. Session creation, loading, saving, branching, tree navigation, fork/switch. |
| `settings-manager.ts` | 959 | `SettingsManager` — reads/writes pi settings (model, theme, keybindings) with file locking. |
| `resource-loader.ts` | 908 | Discovers and loads AGENTS.md, skills, prompt templates, settings from disk. Watches for changes. |
| `model-registry.ts` | 788 | `ModelRegistry` — manages available models, provider registration, model resolution. |
| `model-resolver.ts` | 628 | Resolves model strings to `Model` objects. Handles aliases, defaults, provider prefixes. |
| `skills.ts` | 508 | Skill discovery, loading, expansion. Skills are reusable prompt fragments. |
| `auth-storage.ts` | 493 | OAuth token storage and refresh for API providers. |
| `sdk.ts` | 364 | Public SDK for programmatic pi usage (`createSession`, `prompt`). |
| `agent-session-runtime.ts` | 329 | Runtime initialization: copies default configs, emits `session_start`. Split from agent-session.ts for size. |
| `agent-session-services.ts` | 197 | `AgentSessionServices` interface — dependency injection container for AgentSession. |
| `bash-executor.ts` | 171 | Built-in bash execution with streaming. Used by AgentSession when enhanced-bash extension is NOT loaded. |
| `system-prompt.ts` | 168 | Builds the system prompt from parts (base, AGENTS.md, skills, etc.). |
| `output-guard.ts` | 74 | Intercepts stdout/stderr writes in RPC mode to prevent extensions from corrupting the JSONL protocol. |
| `event-bus.ts` | 33 | Simple typed pub/sub. Extensions use it for cross-extension communication (`pi.events`). |
| `package-manager.ts` | 2254 | Extension/tool package management: npm/bun install, dependency resolution, lockfile handling. |
| `footer-data-provider.ts` | 339 | TUI footer data: git branch, context usage, model info. Watches filesystem for changes. |
| `keybindings.ts` | 302 | Keybinding configuration, defaults (`DEFAULT_EDITOR_KEYBINDINGS`, `DEFAULT_APP_KEYBINDINGS`), key matching. |
| `prompt-templates.ts` | 294 | Prompt template discovery, loading, frontmatter parsing. Templates live in `~/.pi/prompts/`. |
| `messages.ts` | 195 | Custom message types extending base `AgentMessage` + transformer to LLM-compatible format. |
| `resolve-config-value.ts` | 142 | Resolves config values that may be shell commands (`$(cmd)`), env vars (`$VAR`), or literals. Used by auth-storage and model-registry. |
| `exec.ts` | 107 | Shared `spawn`-based command execution for extensions and custom tools. |
| `session-cwd.ts` | 59 | Session working directory tracking and validation. |
| `slash-commands.ts` | 38 | Slash command type definitions and registry (sources: extension, prompt, skill). |

## How AgentSession Wires Everything

```
AgentSession constructor
  → creates Agent (from packages/agent)
  → sets up agent.beforeToolCall / agent.afterToolCall / agent.beforeIdle hooks
  → these hooks delegate to ExtensionRunner at call time (not capture time)

AgentSession._loadExtensions()
  → loadExtensions() from extensions/loader.ts
  → creates ExtensionRunner
  → calls _bindExtensionCore() → runner.bindCore(actions, contextActions)

AgentSession.prompt(text)
  → expands skills/templates
  → checks extension commands (/slash)
  → agent.prompt(message) → runs the loop from packages/agent
  → events flow back through agent.subscribe() → _onAgentEvent() → extension emit
```

## Event Queue Pattern

`_agentEventQueue` serializes async extension event processing. The `beforeIdle` and `afterToolCall` hooks do `await this._agentEventQueue` before calling the extension runner, ensuring all prior event handlers have settled.

## Fork-Specific: How Hold + Steer + BeforeIdle Connect

1. `enhanced-bash.ts` calls `pi.acquireHold()` when backgrounding a command
2. `Agent.getFollowUpMessages` closure blocks instead of returning `[]` while holds exist
3. When the background process finishes, it calls `releaseHold()` + `pi.sendUserMessage(..., { deliverAs: "followUp" })`
4. The follow-up poller wakes up, returns the message, loop continues
5. `agent.beforeIdle` fires `before_idle` extension event — `enhanced-bash.ts` uses this to notify about completed background processes
6. `_queueSteer()` calls `this._extensionRunner?.emitSteer()` → emits `pi:steer` on the event bus → `enhanced-bash.ts` aborts blocking WaitForBash calls

## Stale dist/ Gotcha (Fork)

After rebasing fork patches onto a new upstream release, `dist/` can be stale. If an extension crashes with "Extension runtime not initialized" on a method that IS wired in source, rebuild: `npm run build` from repo root, then `bun link` from `packages/coding-agent/`.

## Subdirectories

- `extensions/` — Extension loading, runtime, runner, types. See `extensions/AGENTS.md`.
- `tools/` — Built-in tool implementations (bash, edit, read, write, find, grep, ls).
- `compaction/` — Context window compaction logic. Defaults: `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`. Auto-compaction triggers when `contextTokens > contextWindow - reserveTokens`. Stale pre-compaction usage is filtered out to avoid false re-triggers. Manual compaction available via RPC `compact` command. `branch-summarization.ts` handles cross-branch context summaries.
- `export-html/` — HTML export templates.
