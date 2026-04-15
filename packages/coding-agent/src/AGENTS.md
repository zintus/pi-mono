# src

Top-level wiring for the coding-agent executable. This directory glues raw CLI args, startup migrations, session selection, runtime creation, and output modes together.

## Fast paths

- **CLI flag / startup bug** → `main.ts` + `cli/args.ts` + `core/model-resolver.ts`
- **`install` / `remove` / `update` / `list` / `config` command** → `package-manager-cli.ts` + `core/package-manager.ts`
- **Wrong package asset or `~/.pi` path** → `config.ts`
- **Startup migration / deprecation warning** → `migrations.ts`
- **Mode-selection weirdness (interactive vs print vs rpc)** → `main.ts` (`resolveAppMode`, `readPipedStdin`, `prepareInitialMessage`)

## File map

| File | Purpose |
|------|---------|
| `cli.ts` | Tiny executable shim. Sets `process.title`, installs the proxy-aware Undici dispatcher, then calls `main()`. |
| `main.ts` | Real entrypoint. Handles package/config subcommands, parses args, opens/forks/resumes sessions, builds runtime services, and dispatches to interactive/print/rpc modes. |
| `config.ts` | Resolves install method, bundled asset paths, and user config dirs under `~/.pi/agent/`. |
| `package-manager-cli.ts` | Handles package-management subcommands before agent startup. |
| `migrations.ts` | One-time startup migrations for auth/session storage, managed binaries, keybindings, and extension-layout changes. |

## Non-obvious startup flow

1. `main.ts` checks raw args for `--offline`, then handles package/config commands **before** `parseArgs()` and session/runtime setup.
2. `parseArgs()` only tokenizes CLI input. Provider/model resolution happens later via `core/model-resolver.ts` during `buildSessionOptions()`.
3. A temporary `SettingsManager` is created in the launch cwd only to find `sessionDir` and drive session selection. Runtime services are built only after the final session cwd is known.
4. Piped stdin can silently flip an interactive launch into print mode. `@file` inputs go through `cli/file-processor.ts`, then `cli/initial-message.ts` merges stdin + file text + the first CLI message.
5. Non-interactive and RPC modes call `takeOverStdout()` early. If debug `console.log` output disappears or the RPC protocol breaks, inspect `core/output-guard.ts` before blaming the mode runner.
6. Interactive-only niceties (theme init, session picker UI, deprecation warnings, startup benchmark UI) all happen after runtime creation; print/json/rpc paths exit much earlier.

## Useful safe smoke tests

```bash
# From packages/coding-agent/
npx tsx src/cli.ts --help
npx tsx src/cli.ts --list-models gpt-5.4
PI_OFFLINE=1 npx tsx src/cli.ts -p --help
```

## Gotchas

- `main.ts` mutates `parsed.messages` when building the initial prompt; helper code that reuses `parsed` must account for that.
- `--session` / `--resume` can move the effective cwd to another project; use `sessionManager.getCwd()` after session resolution, not `process.cwd()`, when tracing runtime behavior.
- Migrations can rename or move files under `~/.pi/agent/` on startup; surprising missing-file behavior is often migration fallout, not a resource-loader bug.
