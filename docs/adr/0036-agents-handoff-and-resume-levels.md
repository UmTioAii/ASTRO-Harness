# ADR-0036: agents, child handoff and resume levels

- Status: accepted
- Date: 2026-11-24
- Issue: #602
- Related decisions: ADR-0006, ADR-0008, ADR-0037

## Context

The bounded-agents phase needs one contract for what a subagent returns, what is persisted when it fails, and what a retry may restore. ADR-0008 owns spawn and inheritance; ADR-0037 owns per-account concurrency. This decision owns the artifact and resume tier and must not persist a child transcript.

## Decision

| Topic | Contract |
|---|---|
| Agent vs subagent | An agent is a declarative skill (role, tools, model, prompt, memory); a subagent is one execution with its own context. The same engine runs both. Creation is model-requested or declaratively rule-matched; free prompt text is never expanded by a heuristic. |
| Happy path | The child returns a summary in the tool result. Nothing is persisted: no handoff artifact and no child transcript. Only ledger usage and state stay. |
| Exception | A failed child writes one `HandoffArtifactV1` at the compact 512-token level (`CHILD_BRIEF_MAX_TOKENS`). The artifact carries `objective`, `output format` (`child_output_format`), `constraints`, `what was tried` (`decisions`) and `boundaries` (`next_steps`). `run` is the child run, `from` is the parent agent, `source_step` is the parent step that delegated, and `source_refs` points at the child ledger interval. The parent transcript is never included; the brief is sanitized before the ledger (I-03). |
| Prompt | The free task prompt never enters the artifact (I-03, D-11/#551): `objective` is a bounded label carrying only `shortTaskHash`. L1/L3 get the prompt text from the live parent, never from the ledger. |
| Bounds | Each brief field is clipped (objective 200 chars, output format 160, list item 120, four items), then `compactDraft` may drop `what was tried`. Loss is audited in `compaction`; `truncated`/`originalTokens`/`returnedTokens` record the cut. Objective, output format and constraints survive. |
| Resume L1 (redo) | Reruns the brief from scratch. Honored **only** on an explicit parent request; restores the brief alone. |
| Resume L2 (resume) | Reopens the live child session and adds an instruction. Default while the child session is alive; restores the brief and the child session, never the journal. `task.resume(sessionID, instruction)` is the contract. |
| Resume L3 (rebuild) | Rebuilds the brief from the artifact plus the ledger interval in `source_refs`. Automatic fallback when the session is gone; restores the brief and the journal, never the child session. |
| Missing artifact | L3 without an artifact is `artifact_missing`; a resume never invents context. |
| Scope | The child inherits tools, round and turn ceilings from the parent (I-01/I-02); a child never spawns a grandchild. |
| Communication | Default is parent-mediated (I-18). The opt-in child-to-child bus (bounded per run, direct addressing, no broadcast, every message copied to the parent as `agent.message`) is a chained slice of #602, not this one. |

`planChildResume` resolves the level and its `restored` list; no level ever restores the parent transcript. The live-session execution of L2 is chained work, because a child transcript is intentionally never persisted.

## Consequences

- Gain: child failures leave a bounded, auditable artifact; retries cannot silently restore more context than the chosen level.
- Cost: an exceptional child writes one extra ledger event and the artifact adds the optional `child_output_format` field to v1.
- Invariants affected: I-01/I-02 (child scope), I-03/I-04 (sanitized events), I-18 (parent-mediated communication).

## Alternatives discarded

- Persist every child transcript: violates the size rule and creates a second source of truth beside the ledger.
- Write the artifact on the happy path: duplicates the summary and pollutes the ledger with non-exceptional events.
- Implicit L1 or L2: a resume would redo or reopen without the parent asking, restoring more context than allowed.
