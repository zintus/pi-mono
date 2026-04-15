# src/modes/rpc — RPC Mode

JSONL-over-stdin/stdout protocol for programmatic control of the coding agent. Used by `pi-loop` daemon (agentbox) and the `RpcClient` SDK.

## Files

| File | Lines | Purpose |
|------|------:|---------|
| `rpc-mode.ts` | 698 | `runRpcMode(session)` — the main loop. Reads JSONL commands from stdin, dispatches to AgentSession, writes JSONL responses/events to stdout. |
| `rpc-types.ts` | 270 | `RpcCommand` and `RpcResponse` discriminated unions — the full protocol spec. |
| `rpc-client.ts` | 506 | `RpcClient` — spawns `pi --mode rpc` as a child process, provides typed async API over the JSONL protocol. |
| `jsonl.ts` | 58 | JSONL line reader/writer utilities shared by mode and client. |

## Protocol

Commands are newline-delimited JSON on stdin. Responses and events on stdout.

Key commands: `prompt`, `steer`, `follow_up`, `abort`, `compact`, `get_state`, `set_model`, `bash`, `get_messages`, `get_system_prompt`, `get_last_assistant_text`, `fork`, `switch_session`, `new_session`.

Every command has an optional `id` field. Responses echo the `id` and include `success: true/false`.

Events (streaming) are emitted with `type: "event"` wrappers around `AgentSessionEvent` payloads.

## Fork-Specific: `get_system_prompt`

Added in this fork for `pi-loop` (agentbox). Returns `{ systemPrompt: string }`. Upstream only has `get_last_assistant_text`.

## Startup Sequence

```
runRpcMode(runtimeHost)
  1. await rebindSession()          // loads extensions, calls bindCore(), subscribes to events
     → extension_ui_request events emitted on stdout here (setStatus, notify)
  2. attachJsonlLineReader(stdin)   // starts reading commands ONLY after rebindSession completes
  3. return new Promise(() => {})   // keep alive forever
```

**Critical:** `bindCore()` (which replaces extension runtime stubs like `acquireHold`) runs inside `rebindSession()`, BEFORE the stdin reader starts. Any prompt arriving on stdin before step 2 is buffered in the pipe and processed after extensions are fully initialized.

## How pi-loop Uses This

```
pi-loop daemon
  → spawns: pi --mode rpc [--model X]
  → connects to stdout via JSONL reader
  → accepts client connections on Unix socket (~/.zeus/loops/<id>/rpc.sock)
  → forwards client commands → stdin, forwards stdout events → client socket
  → uses get_system_prompt to write system-prompt.txt for Zeus web UI
```

pi-loop detects readiness via `extension_ui_request` event (step 1 above). After 500ms delay, it sends `get_session_stats` to get the session ID and transition status from `starting` → `idle`.
