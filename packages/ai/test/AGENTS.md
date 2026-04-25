# packages/ai/test

This directory mixes pure unit tests with live-provider integration. Start with the smallest file that covers the behavior you changed.

## Fast triage

- Single-provider/request-shape bug → matching `<provider>-*.test.ts`
- Cross-provider replay/serialization bug → `cross-provider-handoff.test.ts`
- Broad contract regressions across many providers → `stream.test.ts`, `tokens.test.ts`, `context-overflow.test.ts`, `unicode-surrogate.test.ts`
- Prompt caching / affinity regressions → `openai-completions-prompt-cache.test.ts`, `openai-codex-cache-affinity-e2e.test.ts`, `openai-responses-cache-affinity-e2e.test.ts`

## Running tests

From `packages/ai/` only:
```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/<file>.test.ts
```

`vitest.config.ts` sets `environment: "node"` and a 30s default timeout. Live-network files often add their own `retry` / `timeout` values.

## Credential patterns

- API-key providers usually gate with `describe.skipIf(!process.env.X)`.
- OAuth-capable tests use `test/oauth.ts` `resolveApiKey()`, which reads `~/.pi/agent/auth.json`, refreshes expired tokens, and writes refreshed credentials back.
- Reuse `azure-utils.ts` / `bedrock-utils.ts` for Azure and Bedrock gating instead of duplicating env checks.

## Gotchas

- Many files do top-level `await resolveApiKey(...)`. That work happens at module import time, before Vitest starts running tests.
- `cross-provider-handoff.test.ts` intentionally makes real API calls and dumps failure payloads to `/tmp/pi-handoff-*.json` for inspection.
- `getModel()` is strongly typed from `src/models.generated.ts`; if a model's generated `api` changes, test type errors can come from catalog churn rather than the implementation under test.
- The umbrella matrix tests are expensive and noisy. For a focused regression, prefer a small dedicated test next to the affected provider/helper instead of growing `stream.test.ts` again.

## Useful helpers

- `oauth.ts` — OAuth/API-key resolution via `auth.json`
- `azure-utils.ts` — Azure credential detection + deployment-name map parsing
- `bedrock-utils.ts` — Bedrock credential detection
