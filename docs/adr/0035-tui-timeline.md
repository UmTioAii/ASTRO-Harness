# ADR-0035: TUI timeline contract shared with turn events

- Status: accepted; Date: 2026-11-23; Issue: #595
- Owner files: `src/tui/timeline.ts` (contract and pure renderer), `src/chat/turn-events.ts` (event source)
- Related: ADR-0020, I-03, `docs/superpowers/specs/2026-11-21-tuix-design.md` §4–7, `docs/superpowers/specs/2026-11-21-turn-events.md` §3
## Context

The TUIX spec defines a four-zone continuous-flow screen and S5a (#600) already emits a causal turn-event stream. Both describe the same timeline, so the shape of an entry, its ordering and its redaction cannot live in two places. The screen must also be testable without Ink: a pure function from conversation state to lines.

## Decision

| Topic | Contract |
|---|---|
| Ownership | `src/tui/timeline.ts` owns entry types, layout bands and pure rendering. `src/chat/turn-events.ts` owns event delivery; it never renders. |
| Entries | `reasoning {text, durationMs?}`, `tool {callId, name, arguments, status, durationMs?}`, `answer {markdown}`, `error {message, hint?}`, `notice {message}`. A tool entry carries no `isError` or `resultKey`; `status` is its only completion field. |
| Event mapping | `tool.start` opens a `running` tool entry with `callId`; `tool.end` sets `status = isError ? "failed" : "ok"` and `durationMs`, keeping the same `callId`; the body is stored under that `callId` (never under `resultKey`), so `ctrl+o` expands the right entry. `reasoning` appends a collapsed reasoning entry with the already-sanitized text and no duration or payload. `turn.end` sets the turn status and marks every `running` entry `failed`; `round.start` orders only and is never rendered. |
| Ordering | Causal and append-only. `TurnEventStream` buffers a late event; an entry changing status never reflows the lines above it. |
| Labels | Derived at render time from name and arguments (`read_file src/a.ts`, `command: bun test`, `edit src/a.ts (+2 −1)`); an unknown tool falls back to its name. Labels are not stored. |
| Counters | No rendered state contains a step, round or tool counter. Durations (`420ms`, `4s`) and a cost, shown only when the price is known, are allowed; durations are hidden below 80 columns. |
| Redaction | Every dynamic string crosses `sanitizePromptText` before width measurement (I-03). Block content (answers, expanded output, reasoning) uses `sanitizeBlockText`: ANSI removed first, `redactSecrets` over the whole text (a PEM spans lines), then each line sanitized, keeping indentation; a reasoning block is capped at `MAX_REASONING_CHARS` (16k code points) with a `…` marker. One-line fields collapse whitespace. |
| Purity | `renderTimeline(view, width) => string[]` and `renderTimelineZones` for the four zones have no Ink import, no TTY and no I/O; time and cost arrive as data. Ink zones only join the lines. |
| Width | 120+: 100-column cap with a 2-column margin; 80–119: full width; 60–79: 2-column indent, no durations, last model segment; below 60: no indent and the `ASTRO` wordmark. No line exceeds the supplied width, measured in display columns. |
| Expansion | Collapsed by default. `ctrl+o` reveals tool bodies by `callId`; `ctrl+t` reveals reasoning. A provider without reasoning emits no line, never a placeholder. Both act on the live turn only: committed `<Static>` scrollback is immutable and keeps the state it was printed with. |
| States | `empty`, `thinking`, `streaming`, `approval`, `error`, `done` own zones 2–3; zone 4 (`model · mode · cost`) is always last; until the Ink header is removed, the footer keeps `place · tokens · cost · budget · mode` and omits the model. Approval replaces the composer line while the timeline stays above it. |
| Reuse | `markdown.tsx`, `diff-viewer.tsx` and the keybinding contracts keep theirs; the pure renderer emits plain text and Ink applies styling. `banner.tsx` is removed by the Ink slice, not here. |

## Consequences

- One contract: `callId` is the identity from `tool.start` through `tool.end` and the body map, and `status` is `running` until `tool.end` maps `isError` to `ok`/`failed`.
- The renderer is testable at every width without a terminal; snapshots pin the six states at 120/80/60 and a property test covers 40–200.
- Styling, live wiring, expansion keys, approval focus, `banner.tsx` removal and `app.tsx` size stay in the Ink slice (#635).
- `ctrl+o`/`ctrl+t` are live flags applied when a line is printed: committed `<Static>` lines keep the expansion state they were printed with and are never rewritten (docs/tui-layout.md §Expansions, #595).
