# test — Coding Agent Tests

82 test files. Two harnesses, two conventions.

## Running Tests

```bash
# From packages/coding-agent/ (never from repo root)
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

Never run `npm test` — it runs the entire suite. Only run specific test files.

## Harnesses

### `test-harness.ts` — Top-level tests
Creates an `AgentSession` with a faux stream function. You provide a sequence of canned `AssistantMessage` responses. Good for testing AgentSession behavior (compaction, branching, concurrent prompts, retry, events).

```typescript
import { createTestSession, createFauxStreamFn } from "./test-harness.js";
const streamFn = createFauxStreamFn([{ text: "Hello" }]);
const { session, events } = await createTestSession({ streamFn });
```

### `test/suite/harness.ts` — Suite tests
Uses the faux provider from `@mariozechner/pi-ai` for more realistic multi-turn tests. Supports `FauxResponseStep` sequences. Used for integration-style tests and issue regressions.

```typescript
import { createSuiteSession } from "./harness.js";
```

## File Conventions

| Pattern | Location | Examples |
|---------|----------|---------|
| `agent-session-*.test.ts` | Top-level | Branching, compaction, concurrent, retry, stats |
| `extensions-*.test.ts` | Top-level | Discovery, input events, runner |
| `suite/*.test.ts` | `test/suite/` | Full agent scenarios |
| `suite/regressions/<issue>-<slug>.test.ts` | `test/suite/regressions/` | Issue-specific regressions |
| `*-tool*.test.ts` | Top-level | Tool-specific tests (edit, bash) |
| `rpc*.test.ts` | Top-level | RPC mode/protocol tests |

## Key Test Files

- `extensions-runner.test.ts` — Tests ExtensionRunner dispatch. Fork note: the `extensionActions` mock must include `acquireHold`.
- `rpc.test.ts` — Tests RPC mode protocol handling.
- `test/suite/harness.ts` — Read this before writing suite tests. It configures faux provider, model registry, session manager.

## Fixtures

`test/fixtures/` contains JSON/JSONL fixtures for compaction, session loading, and skill resolution tests.
