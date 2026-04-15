# src/cli

Pure CLI helpers. This directory tokenizes argv, turns `@file` inputs into prompt payloads, and wraps a few interactive selectors. It does **not** resolve models, open sessions, or validate auth — that happens later in `src/main.ts` / `src/core`.

## Fast paths

- **Flag parsing / help text bug** → `args.ts`
- **`@file` handling / inline image issue** → `file-processor.ts`
- **Why the first prompt text looks merged or missing** → `initial-message.ts`
- **`--list-models` output looks wrong** → `list-models.ts` + `core/model-registry.ts`
- **`--resume` picker or `pi config` UI issue** → `session-picker.ts` / `config-selector.ts`

## File map

| File | Purpose |
|------|---------|
| `args.ts` | Tokenizes raw argv into `Args`, records warnings/errors, preserves unknown `--foo` flags for extensions, and renders the long help text. |
| `file-processor.ts` | Resolves `@file` args, wraps text files in `<file name="...">`, detects images, and optionally resizes them before attaching. |
| `initial-message.ts` | Merges stdin text, `@file` text, and the first CLI message into a single initial prompt payload. |
| `list-models.ts` | Prints `modelRegistry.getAvailable()` in a table, optionally fuzzy-filtered. |
| `session-picker.ts` | Thin TUI wrapper used by `--resume`; returns a selected session path or `null`. |
| `config-selector.ts` | Thin TUI wrapper used by `pi config`; owns theme/TUI lifecycle for that screen only. |

## Non-obvious behavior

- `args.ts` stores `--model openai/gpt-5.4` as a plain string. Provider inference and fuzzy matching happen later in `core/model-resolver.ts`.
- Unknown long flags are not rejected immediately; they are captured in `unknownFlags` so extensions can register their own CLI flags.
- `buildInitialMessage()` mutates `parsed.messages` by `shift()`-ing the first message once it has been folded into the initial prompt.
- Empty `@file` inputs are skipped silently. Failed image resizing is converted into an inline text note instead of a hard error.
- `listModels()` uses `modelRegistry.getAvailable()`, not all known models, so the output is filtered by current auth/config state.
- The TUI wrappers here only manage UI lifecycle; they do not apply the selected session/config themselves.

## Safe smoke tests

```bash
# From packages/coding-agent/
npx tsx src/cli.ts --help
npx tsx src/cli.ts --list-models sonnet
npx tsx src/cli.ts @README.md -p --help
```
