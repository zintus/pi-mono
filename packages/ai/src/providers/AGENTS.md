# packages/ai/src/providers

LLM provider implementations. Each converts pi's unified `Message[]` format to a provider-specific API and emits standardized `AssistantMessageEvent` streams.

## File Map

### Provider implementations (one per API type)

| File | API string | SDK | Lines |
|------|-----------|-----|-------|
| `anthropic.ts` | `anthropic-messages` | `@anthropic-ai/sdk` | ~900 |
| `openai-completions.ts` | `openai-completions` | `openai` (Chat Completions) | ~880 |
| `openai-responses.ts` | `openai-responses` | `openai` (Responses API) | ~250 |
| `azure-openai-responses.ts` | `azure-openai-responses` | `openai` (Responses API) | ~250 |
| `openai-codex-responses.ts` | `openai-codex-responses` | `openai` (Responses API) | ~930 |
| `google.ts` | `google-generative-ai` | `@google/genai` | ~480 |
| `google-gemini-cli.ts` | `google-gemini-cli` | `@google/genai` + raw fetch | ~990 |
| `google-vertex.ts` | `google-vertex` | `@google/genai` | ~540 |
| `mistral.ts` | `mistral-conversations` | `@mistralai/mistralai` | ~590 |
| `amazon-bedrock.ts` | `bedrock-converse-stream` | `@aws-sdk/client-bedrock-runtime` | ~810 |
| `faux.ts` | `faux` (dynamic) | None (in-memory test provider) | ~500 |

### Shared modules (not registered as providers)

| File | Used by | Purpose |
|------|---------|---------|
| `register-builtins.ts` | Startup | Lazy-loads all providers, registers them in the global `api-registry`. Never statically imports provider modules. |
| `transform-messages.ts` | All providers | Cross-model message normalization: thinking→text conversion, tool ID remapping, orphaned tool result injection, error/aborted message stripping |
| `simple-options.ts` | All providers | `buildBaseOptions()`, `adjustMaxTokensForThinking()`, `clampReasoning()` — maps `SimpleStreamOptions` to provider-specific options |
| `google-shared.ts` | `google.ts`, `google-gemini-cli.ts`, `google-vertex.ts` | Message conversion, thought signature handling, `isThinkingPart()` |
| `openai-responses-shared.ts` | `openai-responses.ts`, `azure-openai-responses.ts`, `openai-codex-responses.ts` | Shared Responses API streaming logic, event parsing |
| `github-copilot-headers.ts` | `anthropic.ts`, `openai-completions.ts` | Dynamic headers for GitHub Copilot proxy (`X-Initiator`, `Copilot-Vision-Request`) |

## Each provider exports exactly two functions

```typescript
export const stream<Provider>: StreamFunction<"<api>", <Provider>Options>
export const streamSimple<Provider>: StreamFunction<"<api>", SimpleStreamOptions>
```

`streamSimple` maps unified `reasoning: ThinkingLevel` to provider-specific options (effort levels, budget tokens, etc.), then calls `stream`.

## Non-obvious patterns

### Anthropic OAuth stealth mode
When using an OAuth token (`sk-ant-oat*`), `anthropic.ts` mimics Claude Code: renames tools to CC canonical casing (`Read`, `Write`, `Bash`, etc.), injects `"You are Claude Code"` system prefix, sends `claude-code-*` beta headers and `user-agent: claude-cli/<version>`. Tool names are mapped back on response. Version is hardcoded as `claudeCodeVersion`.

### OpenAI Completions compat layer
`openai-completions.ts` serves ~15 different providers (OpenAI, xAI, Groq, Cerebras, OpenRouter, z.ai, etc.) via `OpenAICompletionsCompat` — a ~15-field config controlling reasoning format (`"openai"`, `"zai"`, `"qwen"`, `"openrouter"`), max tokens field name, tool streaming quirks, routing params. Auto-detected from `model.provider`/`model.baseUrl` in `detectCompat()`, overridable via `model.compat`.

### Adaptive vs budget thinking (Anthropic)
Opus 4.6 / Sonnet 4.6 use adaptive thinking (`thinking.type = "adaptive"` + `output_config.effort`). Older models use budget-based (`thinking.type = "enabled"` + `budget_tokens`). `supportsAdaptiveThinking()` checks the model ID. Interleaved thinking beta header is skipped for adaptive models.

### Gemini CLI proxies Anthropic models
`google-gemini-cli.ts` can proxy Anthropic models via Google's Gemini CLI endpoint. When it detects an Anthropic model, it adds the `anthropic-beta: interleaved-thinking` header. Check `needsClaudeThinkingBetaHeader()`.

### Bedrock special loading
`amazon-bedrock.ts` is loaded via `importNodeOnlyProvider()` (a separate function from standard `import()`) because it uses Node-only AWS SDK modules. It also supports `setBedrockProviderModule()` for injecting a pre-built module (e.g., from a bundled app).

### Lazy loading is cached per-promise
Each `load<Provider>ProviderModule()` stores the import promise in a module-level variable (`||=` pattern). First call triggers the dynamic import; subsequent calls return the cached promise. The `createLazyStream`/`createLazySimpleStream` wrappers handle errors from failed imports gracefully.

### transform-messages skips errored/aborted assistant messages
`transformMessages()` silently drops assistant messages with `stopReason === "error"` or `"aborted"`. These are incomplete turns that would cause API errors on replay (e.g., OpenAI rejects "reasoning without following item").

### Prompt caching
`anthropic.ts` adds `cache_control: { type: "ephemeral" }` to system prompt and last user message. Long retention (`ttl: "1h"`) only on `api.anthropic.com` when `cacheRetention === "long"`. Controlled by `PI_CACHE_RETENTION` env var or `options.cacheRetention`.

## Adding a new provider

See root `AGENTS.md` § "Adding a New LLM Provider" for the full checklist (7 steps across types, implementation, registration, models, tests, coding-agent, docs).

Quick summary for this directory:
1. Create `<provider>.ts` exporting `stream<Provider>()` and `streamSimple<Provider>()`
2. Add lazy loader + module-level promise in `register-builtins.ts`
3. Call `registerApiProvider()` in `registerBuiltInApiProviders()`
4. Use `transformMessages()` for cross-provider message normalization
5. Use `buildBaseOptions()` and `adjustMaxTokensForThinking()` from `simple-options.ts`
