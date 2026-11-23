# ADR-0037: per-account concurrency and bounded agents

- Status: accepted; supersedes ADR-0009 A4
- Date: 2026-11-23
- Issue: #602
- Related decisions: ADR-0008, ADR-0009, ADR-0013, ADR-0036

## Context

ADR-0009 A4 made a credential exclusive to one active agent, so fan-out serialized every agent that shared an account. The bounded-agents phase needs parallel children without losing cost or quota accounting: two agents must share an account while consumption stays aggregated by `quotaDomain` and a reservation cannot be erased by a sibling.

## Decision

| Topic | Contract |
|---|---|
| Unit | Concurrency is counted per provider. Active executions are reconstructed from `agent.created`/`agent.destroyed` in the ledger. |
| Default | Two executions per provider, in both profiles. |
| Precedence | explicit request (`agents.maxActive`) > `/config` (`spawn.maxConcurrent`) > 2. Invalid declarations never widen the bound. |
| Grant | `spawn_agent.concurrency` is the model's request; the harness grants `min(requested, cap)` and records `requested`, `granted`, `cap`, `source` and `reason` in `agent.spawn`. A cut is stated in the tool result. |
| Accounts | Up to the cap, agents share one account. A third execution is refused with `account_locked`, naming the active count and the holders. |
| Depth | One, no grandchildren; a spawned child never receives `spawn_agent`. |
| Budget | The reservation check reads the ledger total (all accounts/agents), and reservations are matched by `run` + `agent` so one release cannot erase a sibling's commitment. |
| Recovery | Orphan recovery counts live executions instead of assuming exclusive credential ownership. `astro locks` reports executions and accounts, including how many share an account. |
| Limits | No proactive RPM/TPM limiter; retry remains reactive through `retry-after`. |

## Consequences

- Gain: parallel children become auditable and bounded; the model sees a truncated request instead of repeating it.
- Cost: `spawn.maxActive` (spawns per run) and `spawn.maxConcurrent` (executions per provider) are distinct knobs; the event name changes from `agent.spawned` to `agent.spawn`.
- Invariants affected: I-01/I-02 (child scope never exceeds the parent), I-03/I-04 (sanitized events), I-07 (consumption aggregated by `quotaDomain`).

## Alternatives discarded

- Exclusivity per credential: serializes healthy parallelism and duplicates cost accounting.
- Per-run concurrency only: two runs would still exceed the account's usable rate and reservation ceiling.
- Proactive RPM/TPM limiter: adds a second counter before the provider contract is stable.
