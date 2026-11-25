# ADR-0033: turn and round limits with Default/Control profiles
- Status: accepted; Date: 2026-11-22; Issue: #594; Related decisions: ADR-0014, ADR-0028, ADR-0030, D-31
## Context
Schema 1 overloaded turns and rounds, while Simple/Control left the default profile and migration boundary ambiguous. This decision supersedes the clauses in ADR-0014 and ADR-0030 that deny a turn limit or make Control the implicit preset; their unrelated decisions remain valid.
## Decision
| Topic | Contract |
|---|---|
| Units | A turn is one user request through its final response or stop; a round is one provider call and its subsequent tool processing, per turn and agent visit. |
| Limits | `/config` offers `250`, `500`, `1000` or `unlimited` for `run.maxTurns` and `100`, `200`, `500` or `unlimited` for `run.maxRoundsPerTurn`; a hand-written config may declare any positive integer up to the physical cap `MAX_RUN_LIMIT` (100000), because the limits must be testable at small values. Both default to `500` when no legacy round alias exists. |
| Schema | The supported document is `2.0.0` (`2.2.0` adds keys). Unversioned/`1.x` input declaring `run.maxTurns` fails to load with `config_migration_required`: the file must set the version explicitly after confirming the new meaning, and `config migrate` refuses that document by design. `/config run.maxTurns` writes the current version as part of the opt-in, on a document that already loads, without downgrading a newer version. |
| Aliases | Readable `agent.maxSteps`/`agents.<name>.maxSteps` retain their round meaning; explicit `run.maxRoundsPerTurn` wins. Spawn/task `maxSteps` is rejected with migration guidance. |
| Precedence | Derived defaults never override declared limits or aliases. Project aliases may narrow declared global ceilings; no omitted global limit creates an implicit `500` ceiling. |
| Profiles | `preset: "simple"` normalizes to `default`; omitted presets inherit the global profile, while explicit Default remains reversible against global Control. Default hides turn/round controls and counters; advanced declarations stay validated and effective, but their `/config` edits are Control-only. |
| Shell | `shell.mode: "off"` maps to runtime `sandbox: false`; legacy `true`/`"docker"`/`"auto"` keep their meanings. Same-layer `host`/`auto` conflicts, while compatible aliases and cross-layer narrowing remain valid. |
## Consequences
- An omitted `run` derives limits without enabling legacy loop guards; an explicit legacy `run` retains them. Layer merges retain the newest schema version. Unlimited removes only its corresponding work ceiling, never budget, quota, approval or security controls. The Default profile ignores a declared `quota`/`team.agentQuotas` (warning on load); Control enforces them (#617). Configuration is normalized in memory and never silently rewritten.
