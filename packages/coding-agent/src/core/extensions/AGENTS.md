# src/core/extensions — Extension System

## Files

| File | Lines | Purpose |
|------|------:|---------|
| `types.ts` | 1468 | All extension types: `ExtensionAPI`, `ExtensionEvent` union, `ExtensionActions`, `ExtensionRuntimeState`, event interfaces, handler signatures. The canonical reference for the extension contract. |
| `loader.ts` | 562 | `loadExtensions()` / `discoverAndLoadExtensions()`. Creates runtime with throwing stubs, loads TS/JS files, creates per-extension `ExtensionAPI` objects wired to shared runtime. |
| `runner.ts` | 925 | `ExtensionRunner` — bridges AgentSession and extensions. Receives events, dispatches to handlers, manages tool registration, context creation. |
| `wrapper.ts` | 27 | Wraps `RegisteredTool` (extension-defined) into `AgentTool` (agent-core) using runner's context. |
| `index.ts` | 164 | Re-exports. Massive type re-export list — check here when looking for a type's origin. |

## Data Flow

```
loader.ts: loadExtensions(paths, cwd, eventBus?)
  → createExtensionRuntime(eventBus)     // shared runtime with throwing action stubs
  → for each path: loadExtension()       // evals extension, calls factory(api)
    → createExtensionAPI(ext, runtime, cwd, eventBus)  // per-extension API object
  → returns { extensions, runtime, errors }

AgentSession._loadExtensions()
  → new ExtensionRunner(extensions, runtime, ...)
  → runner.bindCore(actions, contextActions)  // replaces throwing stubs with real impls
    → flushes pendingProviderRegistrations

runner.emit(event) → dispatches to each extension's handlers for that event type
runner.emitToolCall/emitToolResult/emitContext/... → specialized emit with return values
```

## Key Patterns

- **Shared runtime**: All extensions share one `ExtensionRuntime` object. `createExtensionAPI()` creates per-extension facades that delegate to it. Action methods start as throwing stubs, replaced by `bindCore()`.
- **Handler registration**: `pi.on("event_name", handler)` pushes into `extension.handlers` map during `factory(api)` call. Runner iterates extensions in load order when emitting.
- **Tool registration**: `pi.registerTool()` writes to `extension.tools` map and calls `runtime.refreshTools()`. Runner's `getTools()` wraps all registered tools via `wrapper.ts`.
- **Provider registration**: Before `bindCore()`, registrations queue in `runtime.pendingProviderRegistrations`. After `bindCore()`, they go directly to ModelRegistry.

## Fork-Specific Additions

| Addition | Where | Why |
|----------|-------|-----|
| `acquireHold` on `ExtensionActions` + `ExtensionAPI` | types.ts, loader.ts | `enhanced-bash.ts` keeps loop alive during background commands |
| `eventBus` on `ExtensionRuntimeState` | types.ts, loader.ts | Runner needs bus access for `emitSteer()` |
| `emitSteer()` on `ExtensionRunner` | runner.ts | Emits `pi:steer` so extensions can abort blocking tools |
| `BeforeIdleEvent` + `on("before_idle", ...)` | types.ts | Extension event for pre-idle notifications |
| `createExtensionRuntime(eventBus?)` parameter | loader.ts | Avoids creating a second bus; runtime owns the canonical one |

## Gotcha: Runtime Stubs

If an extension calls `pi.sendMessage()` during its factory function (load time), it throws "Extension runtime not initialized." Action methods only work after `runner.bindCore()`. Registration methods (`pi.on`, `pi.registerTool`, `pi.registerProvider`) are safe during load.

## Adding a New Fork Action (Checklist)

When adding a new action method to the extension API (like `acquireHold`), wire it in **all four places** or it stays as the throwing stub at runtime:

1. **`types.ts`** — Add to `ExtensionActions` interface and `ExtensionAPI` interface
2. **`loader.ts`** — Add `notInitialized` stub in `createExtensionRuntime()`, add delegation in `createExtensionAPI()`
3. **`runner.ts`** — Add `this.runtime.<method> = actions.<method>` in `bindCore()`
4. **`agent-session.ts`** — Provide the real implementation in the actions object passed to `runner.bindCore()`

If any step is missed, the method silently stays as the throwing stub and crashes at tool execution time with "Extension runtime not initialized" — misleading because it looks like a load-time error but happens at runtime.

## Gotcha: Stale dist/

After rebasing fork patches, `dist/` can be stale. Symptoms: extension crashes on methods that ARE wired in source. Fix: `npm run build` from repo root, then `bun link` from `packages/coding-agent/`.

**How this manifests in production:** Zeus spawns pi-loop → pi loads `enhanced-bash.ts` → tool calls `acquireHold()` → hits the stale throwing stub in `dist/core/extensions/loader.js` → bun crashes → pi-loop reports `pi stdout closed, consumer exiting (last_status=busy)` → Zeus sees EOF, retries 5 times, each crash identical → reports `pi-loop socket closed: EOF` to Telegram. The error message says "Extension runtime not initialized" which looks like a load-time error, but it's actually a stale-dist problem — the method IS wired in source but `dist/` wasn't rebuilt.

**Quick diagnosis:** compare timestamps: `stat -f '%m' dist/core/extensions/loader.js` vs `stat -f '%m' src/core/extensions/loader.ts`. If source is newer, rebuild.
