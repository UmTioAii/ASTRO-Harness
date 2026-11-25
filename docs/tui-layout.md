# TUI layout

Four continuous-flow zones: identity only in the empty state, an append-only conversation, a stable composer and a status footer (#595, ADR-0035).

Owner files: `src/tui/timeline.ts` (pure renderer and zones), `src/tui/app.tsx` (composition), `src/tui/screens.tsx` (full-screen screens), `src/tui/keys.ts` (composer keys).

## Zones

| Zone | Contents | When |
|---|---|---|
| 1 identity | `ASTRO` wordmark | Empty state only: no live turn and every entry is `info` |
| 2 timeline | prompt, reasoning, tools, answer, errors, notices | Append-only history plus the live turn |
| 3 composer | input box with `❯`, approval takeover, hint, completions | Always the line above the footer |
| 4 status | `modelo · pasta · tokens · custo · orçamento · modo` | Always last |

- Zone 2 never shows a step, round or tool counter (#594). Durations (`420ms`, `4s`) and a curated cost are allowed.
- The tool glyph is `▸` running, `✓` ok, `✗` failed, and changes in place; lines above never reflow.
- Approval replaces the composer contents while the timeline stays visible.
- The model appears once, in zone 4. Version, provider, endpoint and health left the main screen; version/endpoint live in `/log`, health only as a `/log` transition.
- Footer order is `modelo · pasta · in/out tokens · custo · orçamento · modo`; only fields with a value appear, except `modelo` and `modo`. `bypass` is red and also paints the input border.

## Widths

| Width | Layout |
|---|---|
| 120+ | 100-column cap, 2-column indent, full model, block wordmark |
| 80–119 | Full width, no indent, durations, full model |
| 60–79 | 2-column indent, no durations, last model segment |
| below 60 | No indent, `ASTRO` text wordmark |

`renderTimeline` never emits a line wider than the supplied width; the property test covers 40–200. Ink wraps the untouched footer and approval text if the terminal is narrower.

## States

| State | Zone 2–3 |
|---|---|
| empty | wordmark, `astro · /help para comandos · /exit para sair` |
| thinking | `▸ thinking` (no counter) and the streamed partial in a bordered block |
| streaming | sanitized partial answer |
| approval | question wraps above the timeline; answer line and `enter responde · ctrl+c cancela` |
| error | `✗ mensagem` plus `→ próximo passo` |
| done | committed prompt, entries, answer and the composer |

## Expansions and `<Static>` (#635, #595)

- Collapsed by default. `ctrl+o` reveals tool bodies keyed by `callId`; `ctrl+t` collapses the thinking block and reveals reasoning only when the provider emitted it (never a placeholder).
- Every expanded body crosses `sanitizeBlockText` (ANSI, whole-block secrets, per-line sanitizing) before width measurement (I-03).
- **Decision: the flags are live-and-append-only.** `ctrl+o`/`ctrl+t` apply immediately to the live turn and to entries printed while the flag is ON. Committed turns go through Ink `<Static>` and are printed once, so a later toggle never rewrites scrollback: a turn committed expanded stays expanded, one committed collapsed stays collapsed. Reopening history is out of scope; the next turn follows the current flag.
- Rationale: `<Static>` is append-only by design; rewriting it would reparse and reflow the whole transcript and break stable scrollback. Covered by `tests/tui-timeline-wiring.test.tsx` (expanded history survives a toggle; the next live turn follows the flag).
- Cancelling with `ctrl+c` marks every `running` entry `failed`.

## Bindings

`/help` mirrors the composer, leader and approval rows below; every screen also prints its own hint line.

| Context | Binding | Action |
|---|---|---|
| composer | `enter` | Send; during a turn enqueues (`fila: N`); with a completion selected, applies it first |
| composer | `shift+enter` | Newline (kitty `CSI 13;2u` or legacy linefeed) |
| composer | `tab` | Complete command or `@arquivo`; with a completion menu, applies the selection |
| composer | `↑` / `↓` | Move the completion selection |
| composer | `backspace` / `delete` | Delete one character |
| composer | `ctrl+o` | Toggle tool output expansion |
| composer | `ctrl+t` | Toggle the thinking block and the reasoning body |
| composer | `ctrl+c` / `ctrl+d` | Cancel the running turn and exit; a second request exits without waiting |
| leader | `ctrl+x c` | Clear the context |
| leader | `ctrl+x e` / `ctrl+x q` | Exit |
| leader | `ctrl+x m` | List models |
| leader | `ctrl+x n` | New conversation (clear the context) |
| leader | `ctrl+x l` | List saved sessions |
| leader | `ctrl+x t` | Cycle the theme |
| approval | `enter responde` | Submit the typed answer |
| approval | `s aprova uma vez`, `a aprova sempre` | Approve this call only, or the tool for the session (shell: prefix rule) |
| approval | `r recusa`, `n nega` | Reject and cancel pending approvals, or deny this one |
| approval | `tab ver diff` | Open the diff overlay when the call carries a patch |
| screens | `esc` | Close the screen or overlay |
| screens | `↑` / `↓` | Move the cursor |
| screens | `enter` | Confirm the selection |
| screens | `ctrl+c` / `ctrl+d` | Exit |
| sessions screen | `r` / `d`; `s`/`n` confirm | Rename / delete; delete confirmation |
| model picker | `tab`; `ctrl+f` | Move; favourite the current model |
| config screen | `m`; `r`; `e`; `c` / `x` | Mode menu; revoke trust; edit knob; confirm bypass / revoke |
| providers screen | `m`, `→`, `t`, `enter` | Action menu, choose model, test, activate |
| diff viewer | `j` / `k`, `page up` / `page down`, `q` | Scroll and close |
| log screen | `esc` | Back to the conversation |

## Error and state

- Error: `erro: <mensagem> · <próximo passo>`, red, once, in order; the message is redacted (I-03). A fatal error prints the line and ends the session.
- State (provider activated, model changed, session resumed): gray, once per session; identical text does not repeat. A context warning (≥80%) stays inline once; repeats go to `/log`.

## /log

| Goes to `/log` | Stays inline |
|---|---|
| Session header: version, provider, model, endpoint | user and assistant messages |
| `turno concluído` and the per-turn usage line | error with a next step |
| Provider health transitions | approval question and diff |
| Repeated budget, quota and context warnings | the thinking block (no counter) |

- `/log` opens the in-memory buffer; `/log <n>` shows the last `n` lines. Each line carries its lane (`[sessão]`, `[turno]`, `[saúde]`, `[aviso]`) and is sanitized by `appendLog` (I-03). The buffer is memory-only; audit/ledger stay durable.

## Removed states

Endpoint and health in the main screen; provider/model/mode repeated across zones; turn-complete toast; error toast duplicating the error line; per-turn status line in the conversation; step or round counters in the conversation.

## How to verify

- Zones: `tests/tui-frame.test.tsx` pins the empty and completed frames at 80 columns; `tests/tui-timeline.test.ts` covers widths and states.
- Bindings: `tests/tui-help.test.ts` requires every token above in `/help` and in this file.
- Expansions: `tests/tui-timeline-wiring.test.tsx` covers live expansion, redaction and the append-only history.

## Out of scope

Themes, mouse, new keybindings, subagent trees and image rendering.
