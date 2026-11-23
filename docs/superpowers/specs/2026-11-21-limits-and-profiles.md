# S1 — Limits and profiles

> Objective: make turns the primary limit, rounds the loop valve, and Default the product profile.

- Status: in progress (schema 2.0.0 and the `/config` exposure merged in #607/#608)
- Date: 2026-11-21
- ADR: 0033 (supersedes the "turn is not a limit" decision in ADR-0014 and ADR-0030)
- Depends on: none
- Owner files: `src/core/config.ts`, `src/core/session.ts`, `src/chat/agent-session.ts`

## 1. Goal

A thought must never die because a counter ran out. The **turn** is the primary limit, the
**round** is the loop valve, and the product default is the profile that hides both.

## 2. Vocabulary

| Unit | What it is | Counted by |
|---|---|---|
| turn | one user prompt through the final answer, including every round | `run.maxTurns` |
| round | one model call plus the tool calls it asked for | `run.maxRoundsPerTurn` |
| tool call | one tool execution | unlimited |

In code `step` is renamed to `round`; `turn` is reserved. The two limits multiply, they do
not compete: worst case is `turns × rounds`. The primary loop detector stays
`run.noProgressSegments` (ADR-0014); the round limit is the last resort, never the budget.

## 3. Config

```jsonc
{
  "version": "2.0.0",
  "preset": "default",
  "run": { "maxTurns": 500, "maxRoundsPerTurn": 500 }
}
```

| Key | Default | Options | Meaning |
|---|---|---|---|
| `run.maxTurns` | 500 | 250 / 500 / 1000 / unlimited | turns per session |
| `run.maxRoundsPerTurn` | 500 | 100 / 200 / 500 / unlimited | rounds inside one turn |

Both show a spend/loop warning when set to unlimited. `run.maxRoundsPerTurn` is exposed only
in the `control` profile.

## 4. The name collision this must not repeat

`run.maxTurns` existed before and meant **rounds**: `src/spawn.ts:277-293` still accepts
`maxTurns` as an alias of `maxSteps`, and ADR-0008 documents it. Reusing the key with a new
meaning silently reinterprets existing configs, so:

- `version` becomes **2.0.0**. A `1.x` file that declares `run.maxTurns` **fails** with a
  message explaining both meanings and asking for `version: "2.0.0"`.
- In `task`/`spawn`, `maxTurns` means **turns** and `maxRounds` means rounds. `maxSteps` is
  rejected with an error directing callers to `maxRounds`; `maxTurns` is never rounds.

## 5. Migration: aliases, never a rewrite

`docs/config-parity.md:99` and ADR-0028 state that a removed key is **not** migrated by
`astro config migrate`, and `src/core/config-migrate.ts` only stamps `version` — there is no
field-level migration. This spec keeps that contract:

- `agent.maxSteps` loads as an alias of `run.maxRoundsPerTurn` with a warning on load;
- `sandbox` keeps its schema-1 meaning for the shell; the alias table is owned by
  `2026-11-21-host-shell.md` §2, because mapping `true`/`"docker"` to the host would lower a
  security setting;
- no command rewrites a value the user wrote. A field-level migration is a separate issue.

## 6. Profiles

| | `default` | `control` |
|---|---|---|
| is the product default | yes | opt-in via `/config preset control` |
| `/config` shows | model, provider, theme, permission, trusted folder | everything, plus budget, quota, turns, rounds (advanced), fallback, multi-agent |
| turn/round counter on screen | never | only in `/usage`, `/config` and the report |

`preset: "simple"` is accepted as an alias of `"default"` and loads unchanged; the old preset
name must not break an existing config. `DEFAULT_PRESET` is `"default"`
(`src/core/config.ts:145`). Control is reversible and shows a warning on entry.

## 7. Errors

`MaxTurnsError` and `MaxRoundsError` are typed and carry the limit, the current count and the
next action. The turn ends with a human sentence — "stopped here: this task did not
converge" — plus the available action (`/config`, continue, view report). Never a stack
trace. `src/core/session.ts:196-204` already raises `MaxStepsError`; that becomes
`MaxRoundsError`.

## 8. `/usage`

Both profiles show input/output/written tokens and the accumulated cost of the active model
and session. Control adds elapsed turn/round counts, the session/week/month windows and the
remaining budget. Default never shows turn, round or tool counters. A model without a
curated price shows `n/d` once and never breaks the sum.

## 9. Acceptance

- [ ] With defaults, a turn of 12 rounds and 40 tool calls completes.
- [ ] `maxTurns: 1` lets the first turn finish and refuses the second with a human message.
- [ ] A config with `agent.maxSteps` loads with a warning and no rewrite.
- [ ] A `1.x` config declaring `run.maxTurns` fails with both meanings explained.
- [ ] `preset: "simple"` loads and behaves as `default`.
- [ ] Spawn maps `maxTurns` to turns and `maxRounds` to rounds, and rejects `maxSteps` with
      migration guidance.
- [ ] Default renders no turn, round or tool counter; Control confines them to `/usage`,
      `/config` and reports.
- [ ] `step` no longer appears in code or diagnostics; `round` replaces it.

## 10. What #607 and #608 already merged

Schema 2.0.0, both limit keys, their defaults (500 / 500), the unlimited warnings, the
`simple` alias and the `/config` exposure landed in #607 and #608. Those contract tests
already assert the new behaviour; #594 must not "flip" them again.

Remaining RED for #594, written before the code:

| Behaviour | Test to add or update |
|---|---|
| a turn with 12 rounds and 40 tool calls completes | new `tests/limits-turn.test.ts` |
| `run.maxTurns: 1` lets the first turn finish and refuses the second with a human message | `tests/chat-agent-session.test.ts` |
| `run.maxRoundsPerTurn` stops an unconverging turn with `MaxRoundsError` | new `tests/limits-round.test.ts` |
| spawn maps `maxTurns` to turns, `maxRounds` to rounds and rejects `maxSteps` | `tests/spawn.test.ts:67` |
| Default renders no turn, round or tool counter in the conversation or `/usage` | `tests/chat-usage.test.ts`, `tests/tui-banner.test.tsx` |

## 11. Out of scope

Host shell, model catalog, turn events, concurrency, UI rendering.
