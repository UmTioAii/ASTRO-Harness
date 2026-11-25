# Provider, model and credential lifecycle — alpha.6 input

One-line summary: what ASTRO should adopt, and explicitly not adopt, from how two comparable harnesses handle provider/model/credential changes, filtered to the points that improve governance; tracked by #668.

## How to read this

- Source: a static review of two comparable harnesses at their HEAD commits on 2026-11-23, with no execution. A behaviour marked "confirmed" was read in code or tests; "documented" means public docs; "not found" means absent from the reviewed corpus, not proof that it does not exist.
- Unmerged pull requests and feature requests were treated as proposals, never as current behaviour.
- One source repository is `NOASSERTION` with an explicit derivation notice. Only its **public behaviour** is used here — no code, prompt or internal structure.
- Nothing in this document authorises copying an implementation. Each adopted item is reimplemented against ASTRO's invariants (I-01, I-03, I-11).

## Adopt, with our own implementation

| # | Item | Why it improves ASTRO | Slice |
|---|---|---|---|
| A1 | **Config application boundary** — a change applies at a defined point (next model call, next step or next turn) and never rewrites an attempt already resolving or streaming | Neither harness states this for the whole run; today ASTRO is silent about it, so behaviour is accidental | ADR + test |
| A2 | **Typed broken-reference error** — an explicit `provider/model` that no longer resolves fails before the request with an actionable message (restore, switch, or run an explicit migration) | The comparable code fails with a generic "model unavailable" after the fact, or falls back silently; a silent fallback changes cost, destination and billed account | Small: typed error + tests |
| A3 | **Atomic endpoint + credential snapshot per attempt** — provider, model, endpoint and credential version are captured together | Prevents "new endpoint with old secret" and "old endpoint with new secret", both reported publicly as real incidents in the sources | Medium: snapshot object + tests |
| A4 | **Retry boundaries** — retry stays reactive (`retry-after`); abort, bad request and permission failures never retry. | Keeps ASTRO's existing policy explicit instead of drifting into "retry on any error" | Small: policy test |
| A5 | **Destructive-operation confirmation and audit** — removing a provider or credential is confirmed, audited, and reports references that would break | One harness confirms only in its TUI, another only in its CLI, and config edits are unguarded; ASTRO has the audit substrate already | Small: confirm + event |
| A6 | **Doctor: broken references** — `astro doctor` names stale provider/model references (redacted) next to today's checks | The closest equivalent has a redacted doctor but not this check; ASTRO already redacts every check | Small: one check + test |
| A7 | **Served model per turn** — the ledger already records model and route per billable request; expose it interactively | Both sources track it; only one persists it with the message | Small: view |
| A8 | **Export policy** — credentials are never exported through a common API or diagnostics; any export is an explicit, separate operation | One source exposes raw values through a credential endpoint and an auth export; ASTRO's I-03 forbids that by construction | ADR line |

## Rejected on purpose

| Item | Why not |
|---|---|
| Silent fallback when an explicit reference is removed | Hides configuration drift and can change cost, data destination and billed account |
| Automatic promotion of the newest credential | Convenient, but it is a policy decision that must be explicit and audited |
| Rotating endpoint and key independently | Mixes accounts and risks exfiltration |
| Retry on any error | Abort, bad request and permission failures are not transient |
| Secrets in a queryable API, export or diagnostics | Violates I-03; export stays explicit and separate |
| Treating an unmerged PR or a feature request as current behaviour | Source discipline: proposals are not contracts |

## Decisions required before code

1. Does a config change apply on the next model call, the next step or the next turn?
2. Does a retry keep the original endpoint/credential snapshot or may it re-resolve?
3. On removal with live references: block, require migration, disable, or leave a tombstone that fails closed?
4. Is removal during execution blocked, or scheduled for the next boundary?
5. Renaming an id: migrate defaults/agents/sessions/history, or treat it as remove + add with a typed error?
6. Credential pools: cooldown, ordering, attempt limits, non-secret key identifier in audit, per-account cost/quota — all required before any rotation exists.
7. Export: none, or an explicit command with its own consent and audit?

## Deferred deliberately

Credential pools and rotation. The source documents rotation in one harness for authentication, quota and rate-limit triggers, with per-key cooldown. Adopting it without the policy decisions above would trade a visible failure for an invisible one. Tracked by #668, not scheduled.

## What to verify first in ASTRO

- How a removed provider or a stale explicit model reference actually behaves today (typed error vs generic, and whether any path falls back).
- Whether any reload path can apply a partially written config (ASTRO validates strictly; confirm the reload path, not just the loader).
- Whether the model/route recorded in the ledger is sufficient to answer "which model served this turn" without a new store.
