# packages/tui

Low-level terminal rendering library used by `packages/coding-agent` interactive mode and extension custom UIs. Public API examples: `README.md`; extension-facing docs: `../coding-agent/docs/tui.md`. This file is for source-level shortcuts.

## Fast map

- `src/tui.ts` — render pipeline, overlay stack, focus restoration, diffing, IME cursor placement.
- `src/terminal.ts` + `src/stdin-buffer.ts` + `src/keys.ts` — terminal negotiation/parsing (Kitty, `modifyOtherKeys` fallback, bracketed paste, shutdown drain).
- `src/components/*` — built-in widgets.
- `src/index.ts` — public export surface; update it when adding/moving components or helpers.
- `src/keybindings.ts` — TUI-level defaults. App-level bindings are merged in `../coding-agent/src/core/keybindings.ts`.

## Mental model

- TUI renders a full logical line buffer, composites overlays into it, strips `CURSOR_MARKER`, then diffs only the visible viewport. Overlay/resize/style bugs usually live in `src/tui.ts` or `src/utils.ts`, not the component that exposed them.
- Overlay z-order follows focus order. `handle.focus()` both routes input and brings the overlay to the front. `nonCapturing` overlays remain visible but should not steal focus.
- `ProcessTerminal` startup is stateful: raw mode + bracketed paste, Kitty query, `modifyOtherKeys` fallback after ~150ms, then stdin batching through `StdinBuffer`. Exit-time garbage in the parent shell usually points at `drainInput()`.

## Non-obvious invariants

- Every `render(width)` line must fit `width` in visible columns. Use `truncateToWidth()`, `wrapTextWithAnsi()`, `sliceByColumn()` / `sliceWithWidth()`; overflowing lines become render-time failures.
- IME support depends on `Focusable` + `CURSOR_MARKER`. Container components wrapping `Input` / `Editor` must propagate `focused` to the child or candidate windows appear in the wrong place.
- Inline images are not normal text lines. `isImageLine()` gates diffing, slicing, and compositing; image regressions usually belong in `src/terminal-image.ts`, not `src/tui.ts`.
- Height changes usually force a full redraw; Termux is the exception (`isTermuxSession()` branch in `src/tui.ts`). Clearing blank rows after content shrink is opt-in via `setClearOnShrink(true)` or `PI_CLEAR_ON_SHRINK=1`.

## Test / repro shortcuts

- Run the smallest relevant `node:test` file from this package, not `npm test`. Most of this package is not on Vitest; `vitest.config.ts` only targets `test/wrap-ansi.test.ts`.
- Focus / overlay stack regressions: `node --test --import tsx test/overlay-non-capturing.test.ts`
- Diff / resize / clear-on-shrink: `node --test --import tsx test/tui-render.test.ts`
- Style compositing leaks: `node --test --import tsx test/tui-overlay-style-leak.test.ts`
- Key parsing / protocol fallback: `node --test --import tsx test/keys.test.ts`
- Paste splitting: `node --test --import tsx test/stdin-buffer.test.ts`
- Image detection / encoding: `node --test --import tsx test/terminal-image.test.ts`
- Deterministic terminal emulation lives in `test/virtual-terminal.ts`; `waitForRender()` already accounts for the render throttle.
- Live repro for viewport corruption: `npx tsx test/viewport-overwrite-repro.ts`
- Raw ANSI capture: `PI_TUI_WRITE_LOG=/tmp/tui.log <command>`

## Pointers for deeper research

- Overlay behavior in a real extension host: `../coding-agent/examples/extensions/overlay-qa-tests.ts`
- Standalone embedding example: `../coding-agent/examples/rpc-extension-ui.ts`
- Public API / extension-facing docs to update with behavior changes: `README.md`, `../coding-agent/docs/tui.md`, and `../coding-agent/docs/extensions.md`
- If a keybinding change ripples outward, also audit `../coding-agent/docs/keybindings.md` and `../coding-agent/src/core/keybindings.ts`
