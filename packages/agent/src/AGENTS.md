# packages/agent/src — Agent Core Runtime

Low-level stateful agent loop. No coding-agent, CLI, or extension knowledge here — this is the pure model↔tool execution engine.

## Files

| File | Purpose |
|------|---------|
| `agent.ts` | `Agent` class — owns transcript, tool execution, steering/follow-up queues, hold mechanism |
| `agent-loop.ts` | `runAgentLoop()` / `runAgentLoopContinue()` — the inner loop that alternates LLM calls and tool execution |
| `types.ts` | All public types: `AgentLoopConfig`, `AgentEvent`, `AgentTool`, `AgentMessage`, `AgentState` |
| `proxy.ts` | `streamProxy()` — stream function for apps routing LLM calls through a server proxy |
| `index.ts` | Re-exports everything |

## Architecture

```
Agent.prompt(msg)
  → runWithLifecycle()
    → runAgentLoop(messages, context, config, emit, signal, streamFn)
      → runLoop() inner loop:
          1. Stream assistant response via streamFn
          2. Execute tool calls (parallel or sequential)
          3. Drain steering queue → continue if non-empty
          4. Drain follow-up queue → continue if non-empty
          5. Fire beforeIdle hook → re-check queues
          6. Break if all queues empty
```

## Fork-Specific Additions (zintus/pi-mono)

These are NOT in upstream `badlogic/pi-mono`. They support agentbox extensions (`enhanced-bash.ts`):

- **`acquireHold()` / `releaseHold()`** on `Agent`: Prevents the follow-up poller from returning empty when background processes will enqueue messages later. The `getFollowUpMessages` closure in `createLoopConfig` awaits a promise when holds exist but queue is empty.
- **`beforeIdle` hook** on `Agent` and `AgentLoopConfig`: Called in `runLoop()` after follow-up check returns empty. The loop re-checks steering and follow-up queues after the hook runs. Wired from `AgentSession` to emit `before_idle` extension event.
- **`_holdCount` / `_waitResolvers`**: Private fields on `Agent`. `followUp()` and `abort()` call `_wakeWaiters()`. `reset()` clears hold count.

## Key Patterns

- `PendingMessageQueue` is a private class wrapping steering/follow-up arrays with `mode` ("all" or "one-at-a-time") controlling drain behavior.
- `activeRun` tracks the current prompt lifecycle (promise + abort controller). Only one run at a time.
- `subscribe()` listeners receive the run's `AbortSignal` and are awaited in order. `agent_end` listeners settle before `waitForIdle()` resolves.
- `AgentMessage` is a union of LLM `Message` + custom messages via declaration merging on `CustomAgentMessages`.
