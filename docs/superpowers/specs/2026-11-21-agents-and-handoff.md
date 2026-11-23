# S4 — Agents, subagents and handoff

> Objective: define bounded subagent execution, per-account concurrency and auditable handoff.

- Status: draft (alpha.5, phase P4)
- Date: 2026-11-21
- ADR: 0036 (agents and handoff) and 0037 (per-account concurrency, supersedes ADR-0009 A4)
- Depends on: S1 (profiles, limits), S3 (model routing)
- Owner files: `src/spawn.ts`, `src/fan-out.ts`, `src/handoff/`, `src/agent-lock.ts`

## 1. Vocabulary

An **agent** is a declarative skill: role, tools, model, prompt, memory. Persistent,
reusable, versionable in `agents/<name>.md`. A **subagent** is an execution: one session with
its own context, created by the model or by a declared rule, with a scope contained in the
parent's. The agent is the mould; the subagent is the object; the same engine runs both.

## 2. Creation

Two doors, neither mandatory: **spontaneous** (the model calls `task`/`spawn` because the
task needs parallelism) and **declared** (`agents.<name>.when` matched by the harness,
deterministically). Free prompt text such as "create 3 subagents" is **not** expanded by a
harness heuristic: the model asks, the harness decides.

## 3. Concurrency: the model asks, the harness grants

| Rule | Value |
|---|---|
| default per provider | **2**, in both profiles, editable in `/config` |
| precedence | explicit user request > `/config` > 2 |
| depth | **1, no grandchild**, not configurable (`src/spawn.ts:297`) |

Every spawn becomes an `agent.spawn` ledger event with `requested`, `granted`, `cap`,
`source` (`prompt` | `config` | `default`) and `reason`. Above the cap the harness grants the
cap and says so in the tool result — "requested 8, granted 2: profile cap" — so the model
does not repeat the request blindly and the user sees the request in `/usage`.

No proactive RPM/TPM limiter in this phase: `src/providers/openai-compat.ts:314` already
honours `retry-after` with exponential backoff.

## 4. What this revokes in ADR-0009

A4 states that no credential serves two agents at once, and `src/fan-out.ts:94-101` runs each
account group serially. Parallel agents per provider therefore require, in ADR-0037:

1. **Exclusivity moves from credential to quota**: N agents may share an account; concurrency
   is per account and consumption stays aggregated by `quotaDomain` (I-07).
2. **Reservation sums per account, not per run**: `budget.reserved`/`released` matches per
   run today (ADR-0013 B9), so two agents could each pass under the ceiling while together
   exceeding it. The reservation is summed per account before the call.
3. **Crash recovery counts instead of owning**: orphan lock by `pid` becomes a counter;
   `astro locks` reports concurrency, not possession.

Without these three, parallelism produces cost that cannot be audited.

## 5. Return

The happy path returns a **summary**, not persisted. A `HandoffArtifactV1` (ADR-0006) is
written only on exception, at the compact level of 512 tokens
(`src/handoff/compact.ts:16`). The child transcript is never persisted in either case.

The child brief carries `objective`, `output format`, `constraints`, `what was tried` and
`boundaries`. Vague briefs are the main cause of duplicated work; the parent transcript is
never included.

## 6. Resume

| Level | Behaviour | When |
|---|---|---|
| L1 redo | reruns the brief from scratch | only on explicit parent request |
| L2 resume | reopens the child session and adds an instruction | default when the child stopped mid-task |
| L3 rebuild | rebuilds the brief from artifact + journal | automatic fallback when the session is gone |

L2 is exposed as `task.resume(sessionID, instruction)`.

## 7. Children talking to each other

Opt-in per task; the default path stays through the parent. A per-run bus with direct
addressing, no broadcast, bounded messages, every message copied to the parent
(`agent.message`), and artifacts as payload.

## 8. Acceptance

- [ ] `agent.spawn` records requested, granted, cap, source and reason.
- [ ] A request above the cap is truncated and the tool result states the cut.
- [ ] Two agents on one account run in parallel and their budget reservation is summed per
      account before each call.
- [ ] A child cannot spawn another child.
- [ ] The happy path returns a summary and writes no artifact.
- [ ] Every child-to-child message is copied to the parent.

## 9. Out of scope

Background-by-default execution, cross-run federation, agent marketplace, grandchild depth.
