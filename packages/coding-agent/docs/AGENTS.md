# packages/coding-agent/docs — User & Developer Documentation

These are the official docs for pi's coding agent. They document user-facing features, not internal architecture (see `src/core/AGENTS.md` for that).

## Doc Map

| File | Lines | Audience | Covers |
|------|------:|----------|--------|
| `extensions.md` | 2262 | Extension authors | Full extension API: events, tools, commands, UI, rendering, persistence. **The largest doc** — use ToC to navigate. |
| `rpc.md` | 1377 | Integrators | JSONL protocol for headless pi: commands, events, framing. Use this when building non-Node clients. |
| `sdk.md` | 1124 | SDK users | `createAgentSession()` API, events, tools, resource loading. Cross-references `examples/sdk/`. |
| `tui.md` | 887 | Extension authors | TUI component API: `ctx.ui.custom()`, keyboard input, layout, built-in components. |
| `custom-provider.md` | 596 | Operators | Adding custom OpenAI-compatible providers via `models.json`. |
| `session.md` | 412 | Developers | JSONL session file format, entry types, tree structure, branching. |
| `compaction.md` | 394 | Users/devs | Auto-compaction and branch summarization: how, when, config. |
| `models.md` | 341 | Users | `models.json` schema for custom models (Ollama, vLLM, LM Studio, proxies). |
| `themes.md` | 295 | Theme authors | Theme file format, color tokens, custom themes. |
| `settings.md` | 246 | Users | All settings: model, UI, compaction, retry, shell, keybindings. |
| `skills.md` | 232 | Skill authors | Skill format, discovery, expansion, `skill.md` frontmatter. |
| `tree.md` | 231 | Users | `/tree` session history navigation, filtering, branching. |
| `packages.md` | 218 | Package authors | Bundling extensions/skills/themes as npm/git packages. |
| `providers.md` | 195 | Users | Provider setup: OAuth vs API key, env vars, `auth.json`. |
| `keybindings.md` | 175 | Users | Keybinding config, defaults, custom bindings. |
| `terminal-setup.md` | 106 | Users | Terminal requirements, font, true color. |
| `json.md` | 82 | Integrators | `--mode json` one-shot JSON event stream. |
| `development.md` | 71 | Contributors | Dev setup, build, test commands. |
| `prompt-templates.md` | 67 | Users | `/name` prompt templates in Markdown. |
| `tmux.md` | 61 | Users | tmux-specific keybinding workarounds. |
| `windows.md` | 17 | Users | Windows support notes. |
| `shell-aliases.md` | 13 | Users | Shell alias expansion. |

## When to Reference Which Doc

- **"How do extensions work?"** → `extensions.md` (events, tools, commands, rendering)
- **"How do I embed pi in my app?"** → `sdk.md` (Node/TS) or `rpc.md` (any language, subprocess)
- **"How do I add a custom model?"** → `models.md` (user) or `custom-provider.md` (operator)
- **"Where are API keys stored?"** → `providers.md` (env vars, `~/.pi/agent/auth.json`)
- **"How does the session file work?"** → `session.md` (JSONL format, tree structure)
- **"How do I build TUI components in extensions?"** → `tui.md`

## Editing Guidelines

- These docs are user-facing — write for someone using pi, not someone reading its source.
- `extensions.md` is the canonical reference for the extension API. If you change extension behavior in source, update this doc.
- `rpc.md` documents the wire protocol. Keep command/event schemas in sync with `src/modes/rpc/`.
- `sdk.md` cross-references `examples/sdk/`. If you add an example, add a row to the table in `sdk.md`.
