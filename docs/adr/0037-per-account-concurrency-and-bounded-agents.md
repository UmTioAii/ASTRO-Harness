# ADR-0037: bounded agent concurrency

- Status: accepted
- Date: 2026-11-23
- Issue: #602
- Related decisions: ADR-0008, ADR-0009, ADR-0013

## Context

The model can ask for several subagents, but the harness needs one auditable bound and must not let a request silently exceed it. This slice defines the bound and the `agent.spawn` contract; shared-account capacity (ADR-0009 A4 replacement) ships in the follow-up slice.

## Decision

| Topic | Contract |
|---|---|
| Bound | Resolved once per run from `agents.maxActive` (explicit request) > `spawn.maxConcurrent` (`/config`) > 2. Invalid declarations never widen it. |
| Grant | `spawn_agent.concurrency` is the model's request; the harness grants `min(requested, cap)` and records `requested`, `granted`, `cap`, `source` and `reason` in `agent.spawn`. A cut is stated in the tool result. |
| Source | `request` for `agents.maxActive`, `config` for `spawn.maxConcurrent`, `default` for 2. |
| Admission | Unchanged in this slice: ADR-0009 A4 still gives one execution per account, so `granted` is clamped to that executable ceiling. |
| Depth | One, no grandchildren; a spawned child never receives `spawn_agent`. |
| Limits | No proactive RPM/TPM limiter; retry remains reactive through `retry-after`. |

## Consequences

- Gain: the bound and the truncation are auditable before any capacity model changes.
- Cost: until shared accounts land, `granted` can be lower than the resolved request bound; the tool result states the cut.
- Invariants affected: I-01/I-02 (child scope never exceeds the parent), I-03/I-04 (sanitized events).

## Alternatives discarded

- Emitting the request without a harness bound: the model would repeat an impossible ask.
- Proactive RPM/TPM limiter: adds a second counter before the provider contract is stable.
