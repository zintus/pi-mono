# packages/coding-agent

The full coding agent: CLI, TUI, extension system, RPC mode, tools, session management. Built on top of `packages/agent` (core loop) and `packages/ai` (LLM providers).

## Source Layout

```
src/
  AGENTS.md         # Top-level startup / entrypoint wiring (`cli.ts`, `main.ts`, `config.ts`, migrations)
  cli/              # CLI helpers and argument parsing
  core/             # AgentSession, extensions, tools, models, sessions — see src/core/AGENTS.md
  modes/
    interactive/    # TUI mode (terminal UI with ink)
    rpc/            # RPC mode (JSONL over stdin/stdout) — see src/modes/rpc/AGENTS.md
    print-mode.ts   # One-shot print mode
```

## Key Commands

```bash
# Type check (from repo root) — always do this after changes
npm run check

# Run a specific test (from this package dir)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts

# NEVER run: npm run dev, npm run build, npm test
```

## Testing

Two test harnesses exist — choose based on what you're testing:

| Harness | Location | Use for |
|---------|----------|---------|
| `test/test-harness.ts` | Top-level tests | AgentSession runtime tests with faux stream function |
| `test/suite/harness.ts` | Suite tests | Full agent tests using the faux provider from `@mariozechner/pi-ai` |

- Suite tests go in `test/suite/`. Regression tests go in `test/suite/regressions/<issue>-<slug>.test.ts`.
- Both harnesses use in-memory faux providers. Never use real API keys or paid tokens in tests.
- If you modify a test, you MUST run it and iterate until it passes.

## Fork-Specific Features (zintus/pi-mono)

Features added to support agentbox extensions, not present in upstream:

- `acquireHold()` in ExtensionAPI and ExtensionActions — keeps agent loop alive for background work
- `pi:steer` event emission via `ExtensionRunner.emitSteer()` — notifies extensions of steering
- `before_idle` extension event — fired when agent would go idle, allows extensions to enqueue work
- `eventBus` on `ExtensionRuntimeState` — gives runner access to the shared event bus
- `get_system_prompt` RPC command — lets pi-loop read the system prompt

See `src/core/AGENTS.md` and `src/core/extensions/AGENTS.md` for details.
