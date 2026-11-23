# TUIX — continuous-flow terminal UI

> Objective: present identity, conversation, activity and composer state without progress counters or layout reflow.

- Status: approved design (alpha.5, phase P2)
- Date: 2026-11-21
- Depends on: S1 (no counters), S5a (turn events), ADR-0035
- Owner files: `src/tui/`, `docs/tui-layout.md` (rewritten by this spec)

## 1. Goal

Make `astro` feel like a product, not a log: an empty state that carries identity, a
conversation that reads as text, and a footer that holds every piece of live state in one
predictable place. No step, round or tool counter in any state.

## 2. Principles

1. **Identity only when empty.** The logo and name exist while there is no conversation.
   Afterwards the screen is content; no permanent header repeats the model.
2. **The conversation is text, not a box.** No border, no gutter, no right-aligned column.
   Selecting with the mouse and pasting into an issue must yield clean text.
3. **State lives in the footer.** Activity, composer and context line keep the same
   position on every frame, so the eye never searches.

## 3. Anatomy — four zones, no header

```
zone 1  content      history + current turn (append-only <Static>, terminal scrolls)
zone 2  activity     one line: thinking or streaming tail
zone 3  composer     one line; two when an approval takes over
zone 4  status       one dim line: model · mode · cost (control only)
```

Zone 1 is `<Static>`: nothing above the streaming line ever moves.

## 4. Turn model

```ts
type Turn = { id: string; prompt: string; entries: Entry[]; usage?: Usage; status: TurnStatus }

type Entry =
  | { kind: "reasoning"; text: string; durationMs: number }   // runtime only
  | { kind: "tool"; callId: string; name: string; label: string;
      status: "running" | "ok" | "failed"; durationMs?: number; resultKey?: string }
  | { kind: "answer"; markdown: string }
  | { kind: "error"; message: string; hint?: string }
  | { kind: "notice"; message: string }                        // state, once per session
```

Rendering is pure: `renderTurn(turn, width, expanded) => string[]`. Unit-testable without
Ink; the Ink components only compose the strings.

**Tool label** is derived, not stored: `read_file src/a.ts`, `command: bun test`,
`edit src/a.ts (+12 −4)`. Unknown tool falls back to its name.

**Order is causal and append-only.** An out-of-order stream event is buffered until its
predecessor arrives; a turn that aborts marks every `running` entry as `failed`.

## 5. Required events and reasoning (S5a)

S5a owns the observer contract for `round.start`, `tool.start`, `tool.end` and `turn.end`,
plus the runtime-only reasoning channel. The TUIX consumes both; `roundIndex` only orders
events and is never rendered.

- Provider emits reasoning → `▸ reasoning · 4s`, collapsed by default, `ctrl+t` expands.
- Provider does not emit it → the line does not exist. No placeholder, no fake timer.

## 6. States

| State | Zone 2 | Zone 3 | Zone 4 |
|---|---|---|---|
| empty | — | `❯` with logo above | visible |
| thinking | `▸ thinking · 12s` | `❯` disabled | visible |
| streaming | answer growing in zone 1 | disabled | visible |
| approval | frozen | approval panel | visible |
| error | `✗` + reason + next step | active | visible |
| done | nothing | active | visible |

Forbidden in every state: step, round and tool counters. Duration and cost are allowed and
are not progress counters.

## 7. Widths

| Width | Content | Changes |
|---|---|---|
| ≥120 | cap 100 columns, 2-column margin | durations visible, full model ref |
| 80–119 | full width | durations visible |
| 60–79 | full width, 2-column indent | durations hidden, model shortened to last segment |
| <60 | full width, no indent | logo becomes the single word `ASTRO`, truncation keeps the tail (file name) |

The logo is three lines of half-block letters (`█▀▄`), all ASCII-safe for Windows terminals.
Nothing is centered by terminal width alone; centering is computed from the measured logo
width so a 60-column window never wraps it.

## 8. Components

| File | Role | State |
|---|---|---|
| `chat-view.tsx` | zones 1–2, renders `Turn[]` | new |
| `entry.tsx` | prompt, answer, error, separator | new |
| `tool-line.tsx` | one-line tool + expand | new |
| `empty-state.tsx`, `logo.tsx` | identity with width degradation | new |
| `composer.tsx` | borderless input, multiline, history | new |
| `status-line.tsx` | model · mode · cost | new |
| `approval-panel.tsx` | approval in zone 3 | new, reuses `approvals.ts` |
| `app.tsx` | orchestrates zones | shrinks from 1033 to ~350 lines |
| `banner.tsx` | current header/footer | deleted |

Existing components keep their contract: `markdown.tsx`, `diff-viewer.tsx`, `theme.ts`,
`keybinds.ts`, `commands.ts`, `session-picker.tsx`, `model-picker.tsx`, `config-screen.tsx`,
`provider-screen.tsx`.

## 9. Keybindings

`ctrl+o` expand the last tool (control profile: all tools in the turn) · `ctrl+t` expand
reasoning · `esc` cancel the turn and mark running entries as failed · `ctrl+c` twice to
exit · `!cmd` shell · `/` commands. No new binding outside this list; all of them appear in
`/help`.

## 10. Acceptance

- [ ] Snapshots at 120, 80 and 60 columns for the six states.
- [ ] Property test: no rendered line exceeds the given width, for widths 40–200.
- [ ] No rendered state contains a step, round or tool counter (asserted on the rendered
      output, not on the source).
- [ ] A turn with 3 tools shows each line moving `running → ok/failed` without reflow above.
- [ ] `ctrl+o` expands a tool result; secrets are redacted in the expanded block (I-03).
- [ ] `ctrl+t` expands reasoning when the provider emits it, and the line is absent when it
      does not.
- [ ] Approval takes over zone 3 and the timeline stays visible and readable.
- [ ] A 60-column terminal never wraps a rendered line at any state.
- [ ] `banner.tsx` is gone and `app.tsx` is under 400 lines.

## 11. Out of scope

Subagent tree in the timeline (P4 adds a single `⤷ 2 subagents` line with `ctrl+o`), themes
beyond the existing tokens, mouse support, image rendering, i18n of the UI (it is written in
English, not translated at runtime).
