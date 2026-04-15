# packages/ai/src — LLM Provider Abstraction Layer

Unified streaming interface over multiple LLM providers. No agent logic — just model definitions, API key resolution, and provider-specific HTTP/SDK calls.

## Architecture

```
stream.ts / index.ts (public API)
  → api-registry.ts (provider lookup by Api string)
    → providers/register-builtins.ts (lazy-loads provider modules on first use)
      → providers/<provider>.ts (HTTP calls, response parsing, event emission)
```

**Two stream variants per provider:**
- `stream()` — raw provider options (e.g., `toolChoice`, `reasoningEffort`)
- `streamSimple()` — unified `SimpleStreamOptions` with `reasoning: ThinkingLevel`

Both return `AssistantMessageEventStream` (push-based async iterable in `utils/event-stream.ts`).

## Key Files

| File | Purpose |
|------|---------|
| `types.ts` | All shared types: `Model`, `Api`, `KnownProvider`, `Message`, `AssistantMessageEvent`, `StreamFunction`, `OpenAICompletionsCompat` |
| `api-registry.ts` | Global `Map<Api, ApiProvider>`. `registerApiProvider()` / `getApiProvider()`. Extensions can register custom APIs here. |
| `stream.ts` | Public `stream()`, `complete()`, `streamSimple()`, `completeSimple()` — thin wrappers that resolve API → provider → call |
| `models.ts` | `getModel()`, `getModels()`, `calculateCost()`, `supportsXhigh()` — reads from `models.generated.ts` |
| `models.generated.ts` | ~360KB auto-generated model catalog. **Never edit manually** — regenerate via `packages/ai/scripts/generate-models.ts` |
| `env-api-keys.ts` | `getEnvApiKey(provider)` — maps provider names to env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) |
| `cli.ts` | Standalone OAuth login CLI (`pi-ai login <provider>`) |
| `index.ts` | Re-exports. Uses `export type` for provider option types to keep them tree-shakeable. |

## Provider Implementation Pattern

Every provider file in `providers/` follows the same structure:

1. **Export** `stream<Provider>()` and `streamSimple<Provider>()` (both `StreamFunction`)
2. **Convert** pi `Message[]` → provider-native format (e.g., Anthropic `MessageParam[]`)
3. **Stream** via provider SDK or raw `fetch` with SSE parsing
4. **Emit** standardized `AssistantMessageEvent` sequence: `start` → deltas → `done`/`error`
5. **Calculate** token usage via `calculateCost()` from `models.ts`

### Shared code between providers

| File | Shared by |
|------|-----------|
| `transform-messages.ts` | All providers — cross-model message normalization (thinking→text, tool ID normalization, orphaned tool result injection, error message stripping) |
| `simple-options.ts` | All providers — `buildBaseOptions()`, `adjustMaxTokensForThinking()`, `clampReasoning()` |
| `google-shared.ts` | `google.ts`, `google-gemini-cli.ts`, `google-vertex.ts` — message conversion, thought signature handling |
| `openai-responses-shared.ts` | `openai-responses.ts`, `azure-openai-responses.ts`, `openai-codex-responses.ts` — shared Responses API streaming logic |
| `github-copilot-headers.ts` | `anthropic.ts`, `openai-completions.ts` — dynamic headers for Copilot proxy |

### Lazy loading

Provider modules are **never statically imported** in `register-builtins.ts`. Each gets a `load<Provider>ProviderModule()` that does `import("./provider.js")` on first call, cached via a module-level promise variable. This keeps startup fast and avoids loading unused SDK dependencies.

## utils/

| File | Purpose |
|------|---------|
| `event-stream.ts` | `EventStream<T,R>` — generic push-based async iterable with `result()` promise. `AssistantMessageEventStream` specializes it. |
| `overflow.ts` | Context window overflow detection — counts tokens, determines if compaction needed |
| `json-parse.ts` | `parseStreamingJson()` — incremental JSON parser for streaming tool call arguments |
| `validation.ts` | TypeBox schema validation for tool parameters |
| `sanitize-unicode.ts` | Strips unpaired surrogates from LLM output (prevents JSON serialization errors) |
| `hash.ts` | SHA-256 helper |
| `typebox-helpers.ts` | TypeBox schema utilities |
| `oauth/` | OAuth flows for Anthropic, GitHub Copilot, Google (Gemini CLI, Antigravity), OpenAI Codex |

## Gotchas

- `models.generated.ts` is huge. Don't read it — use `getModel("provider", "id")` or `getModels("provider")`.
- `OpenAICompletionsCompat` in `types.ts` has ~15 fields controlling behavior for OpenAI-compatible APIs (reasoning format, max tokens field name, tool result requirements). Providers auto-detect from `baseUrl` but custom providers may need explicit `compat` overrides on their `Model`.
- `faux.ts` is the test provider. `registerFauxProvider()` returns a handle with `setResponses()` for queuing canned responses. Used by both test harnesses in `packages/coding-agent`.
- The `Api` type (e.g., `"anthropic-messages"`) is distinct from `Provider` (e.g., `"anthropic"`). Multiple providers can share an API (e.g., GitHub Copilot uses `"anthropic-messages"` API).
- Auth follows the **provider**, not the model family name: `openai` reads `OPENAI_API_KEY`, `openai-codex` uses the Codex OAuth path, and `anthropic` prefers `ANTHROPIC_OAUTH_TOKEN` over `ANTHROPIC_API_KEY`. Swapping `openai/gpt-5.4` ↔ `openai-codex/gpt-5.4` changes auth behavior, not just model metadata.
