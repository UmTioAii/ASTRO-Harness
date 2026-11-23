# S5a — Turn events

> Objective: expose a live, causal and sanitized event stream for each turn.

- Status: draft (alpha.5, phase P1)
- Date: 2026-11-21
- ADR: 0035 (shared with the TUIX spec; planned for this phase, not yet written)
- Depends on: S1 (round naming)
- Owner files: `src/chat/agent-session.ts`, `src/tools/executor.ts`, `src/chat/hooks.ts`

## 1. Goal

Give the UI a live, causal stream of what a turn is doing, so a tool line can be rendered
while the tool runs instead of after the turn ends.

## 2. The gap this closes

Today the TUI constructs `AgentSession` without any hook (`src/tui/run.tsx:250-262`), the
existing hooks fire **once, at the end of the turn** (`src/chat/agent-session.ts:290-320`),
and the only live signals are the streaming text delta and `onStep(step, max)` before each
provider call — exactly the counter the product is removing. `✓ read_file 0.4s` cannot be
built from that.

The per-call timing already exists as audit: `tool.call` at `src/tools/executor.ts:222` and
`tool.result` at `:230`, with `callId` and `durationMs`. This spec exposes those points as an
observer, without reading audit files back.

## 3. Events

```ts
type TurnEvent =
  | { kind: "round.start"; turnId: string; roundIndex: number; at: string }
  | { kind: "tool.start"; turnId: string; callId: string; name: string; arguments: string; at: string }
  | { kind: "tool.end"; turnId: string; callId: string; isError: boolean;
      durationMs: number; resultKey: string; at: string }
  | { kind: "turn.end"; turnId: string; status: "done" | "failed" | "cancelled";
      usage: Usage; at: string }
```

| Rule | Why |
|---|---|
| payload sanitized at the source | I-03, same discipline as `src/chat/hooks.ts`; `tool.start` redacts `arguments` before delivery, so path, query or value content never reaches the observer raw |
| large results travel by `resultKey` | an event is a signal, not a transport |
| an observer error never aborts the turn | the observer is a consumer, not a dependency |
| `roundIndex` is internal | it orders; it is never rendered |
| `onStep` becomes `round.start` | one source of progress, in the new vocabulary |

## 4. Ordering

Events are causal and append-only. An out-of-order delivery is buffered until its
predecessor arrives. When a turn is cancelled or fails, every entry still `running` is marked
`failed`, so the consumer never waits for a result that will not come.

## 5. Reasoning channel

`ChatMessage` has no reasoning field (`src/providers/types.ts:11`). The adapter gains a
runtime-only `reasoning` string, filled from `reasoning_content` deltas when the model card
declares `reasoning: true`. It is never persisted, never sent back to the provider and never
logged; the UI renders it only when present.

## 6. Existing hooks are unchanged

`onMessage` and `onToolResult` keep their end-of-turn contract: they feed memory and other
consumers, not the timeline. The new observer is an additional, optional callback on
`sendTurn`, not a change to their semantics.

## 7. Acceptance

- [ ] `tool.start` reaches the observer before the tool executes and `tool.end` carries its
      real duration and error flag.
- [ ] A turn cancelled mid-tool marks every pending entry as `failed`.
- [ ] A tool whose result contains a secret emits a redacted payload (I-03), and
      `tool.start.arguments` goes through the same sanitizer before it reaches the observer.
- [ ] An observer that throws does not change the turn outcome.
- [ ] A provider without a reasoning channel emits no reasoning event.
- [ ] `onStep` is gone; `round.start` carries the same timing without exposing a counter.

## 8. Out of scope

Timeline rendering (TUIX spec), persistence of events, replay, multi-agent fan-out.
