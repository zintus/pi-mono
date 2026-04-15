# examples/sdk — Programmatic pi Usage Examples

Numbered examples showing `createAgentSession()` usage, from minimal to full control. Each is a standalone runnable script.

## Running

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

Requires API keys (env vars or `~/.pi/agent/auth.json`). All examples use real LLM calls except where noted.

## Example Progression

Examples build on each other conceptually. Read in order when learning the SDK.

| # | File | Key imports | What it teaches |
|---|------|-------------|-----------------|
| 01 | `01-minimal.ts` | `createAgentSession` | Zero-config: all defaults, auto-discover everything |
| 02 | `02-custom-model.ts` | `getModel`, `ModelRegistry` | Three ways to pick a model: `getModel()`, `modelRegistry.find()`, `getAvailable()` |
| 03 | `03-custom-prompt.ts` | `DefaultResourceLoader` | `systemPromptOverride` (replace) vs `appendSystemPromptOverride` (extend) |
| 04 | `04-skills.ts` | `Skill`, `createSyntheticSourceInfo` | Filter discovered skills, add inline skills |
| 05 | `05-tools.ts` | `codingTools`, `readOnlyTools`, `createReadTool` | Built-in tool sets vs individual tools. **Use `create*Tool(cwd)` factories when `cwd` differs from `process.cwd()`** |
| 06 | `06-extensions.ts` | `DefaultResourceLoader` | Inline extension factories, file-based extensions, `pi.registerTool()`, `pi.registerCommand()` |
| 07 | `07-context-files.ts` | `DefaultResourceLoader` | Override AGENTS.md discovery |
| 08 | `08-prompt-templates.ts` | — | File-based `/name` slash commands |
| 09 | `09-api-keys-and-oauth.ts` | `AuthStorage`, `ModelRegistry` | Default `~/.pi/agent/auth.json`, custom path, `setRuntimeApiKey()` |
| 10 | `10-settings.ts` | `SettingsManager` | `applyOverrides()`, `inMemory()` for tests, `flush()`, `drainErrors()` |
| 11 | `11-sessions.ts` | `SessionManager` | `inMemory()`, `create()`, `continueRecent()`, `open()`, `list()` |
| 12 | `12-full-control.ts` | Everything | No auto-discovery: explicit `ResourceLoader`, custom auth path, factory tools |
| 13 | `13-session-runtime.ts` | `createAgentSessionRuntime` | Session replacement (new/switch/fork) with `AgentSessionRuntime` |

## Common Patterns

**Subscribing to output** — every example uses this pattern:
```ts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
```

**In-memory for tests** — pass `SessionManager.inMemory()` to avoid writing session files to disk.

**DefaultResourceLoader** — the gateway to customizing prompt, skills, extensions, context files. Accepts override callbacks that receive current values and return modified ones. Always call `await loader.reload()` after construction.

**ResourceLoader interface** (example 12) — implement directly when you want zero auto-discovery. Simpler than `DefaultResourceLoader` but you must provide everything yourself.

## Gotchas

- `createAgentSession()` requires `authStorage` and `modelRegistry` in most examples. Example 01 works without them only because it auto-creates defaults.
- Tool path resolution: `readTool`, `bashTool` etc. are singletons bound to `process.cwd()`. If you pass a different `cwd` to `createAgentSession`, use `createReadTool(cwd)` etc. or paths will resolve wrong.
- `DefaultResourceLoader` reads from disk (`~/.pi/agent/`, `<cwd>/.pi/`). For hermetic tests, use the `ResourceLoader` interface directly (example 12).
