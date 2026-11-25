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
| Unit | Concurrency is counted per account (`credentialRef`), the unit the lock enforces. Distinct credentials are distinct accounts; providers that share a credential share one account and one count. |
| Default | Two executions per account, in both profiles. |
| Precedence | explicit request (`agents.maxActive`) > `/config` (`spawn.maxConcurrent`) > 2. Invalid declarations never widen the bound. The physical ceiling is 8 (`MAX_ACTIVE_AGENTS`) and the explicit tier wins even when `/config` declares a lower value. |
| Grant | `spawn_agent.concurrency` is the model's request; the harness grants `min(requested, cap)` and records `requested`, `granted`, `cap`, `source` (`request`/`config`/`default`), the model-choice `reason`, the grant `grant_reason` and `cut` when truncated in `agent.spawn`. A cut is stated in the tool result. `source` is the concurrency tier for every spawn; `door` records who asked (`model` or `rule`) and, for a rule, `rule` names the agent (ADR-0036). |
| Accounts | Up to the cap, agents share one account. Capacity is the cap minus executions already active on that account; the surplus is refused. `task` children record their own execution, so fan-out and `astro locks` see the real count. Capacity pre-admission refuses with `spawn_limit_exceeded`; a lock race still returns `account_locked` (D-18). |
| Depth | One, no grandchildren; a spawned child never receives `spawn_agent`. |
| Budget | The reservation read and `recordBudgetReserved` run under the ledger file lock (fail closed), and reservations are matched by `run` + `agent` so one release cannot erase a sibling's commitment. The decision prompt is never inside the lock; the post-decision recheck covers the ceiling/unknown price (the soft limit was explicitly continued or raised). |
| Recovery | Orphan recovery counts live executions instead of assuming exclusive credential ownership. `astro locks` reports executions and accounts, including how many share an account. |
| Limits | No proactive RPM/TPM limiter; retry remains reactive through `retry-after`. |

## Consequences

- Gain: parallel children become auditable and bounded; the model sees a truncated request instead of repeating it.
- Cost: `spawn.maxActive` (spawns per run) and `spawn.maxConcurrent` (executions per account) are distinct knobs; the event name changes from `agent.spawned` to `agent.spawn`.
- Consequence: `agents.maxActive` is both the run's active-agent ceiling and the explicit concurrency request. A declared `agents.maxActive: 8` on one shared credential therefore admits up to eight concurrent executions (still bounded by the `spawn.maxActive` spawn ceiling). The key is intentionally shared; a dedicated key is future work.
- Invariants affected: I-01/I-02 (child scope never exceeds the parent), I-03/I-04 (sanitized events), I-07 (consumption aggregated by `quotaDomain`).

## Alternatives discarded

- Exclusivity per credential: serializes healthy parallelism and duplicates cost accounting.
- Per-run concurrency only: two runs would still exceed the account's usable rate and reservation ceiling.
- Proactive RPM/TPM limiter: adds a second counter before the provider contract is stable.
