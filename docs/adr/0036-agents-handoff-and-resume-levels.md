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
| Agent vs subagent | An agent is a declarative skill (role, tools, model, prompt, memory); a subagent is one execution with its own context. The same engine runs both. Creation is model-requested; the declarative `when` matcher is still open on #602. Free prompt text is never expanded by a heuristic. |
| Happy path | The child returns a summary in the tool result. Nothing is persisted as a handoff artifact or transcript; only ledger usage and state stay. When `run.checkpointAt` is configured, the pre-existing loop checkpoint may write a bounded child summary under `.astro/sessions/<childRun>/<agent>/checkpoint.json`; that is a checkpoint, not the transcript. |
| Exception | A failed child writes one `HandoffArtifactV1` at the compact 512-token level (`CHILD_BRIEF_MAX_TOKENS`). The artifact carries `objective`, `output format` (`child_output_format`), `constraints`, `what was tried` (`decisions`) and `boundaries` (`next_steps`). `run` is the child run, `from` is the parent agent, `source_step` is the parent step that delegated, and `source_refs` points at the child ledger interval. The parent transcript is never included; the brief is sanitized before the ledger (I-03). |
| Prompt | The free task prompt never enters the artifact (I-03, D-11/#551): `objective` is a bounded label carrying only `shortTaskHash`. L1/L3 get the prompt text from the live parent, never from the ledger. |
| Bounds | Each brief field is clipped (objective 200 chars, output format 160, list item 120, four items), then the serialized draft is trimmed until `estimateTokens(JSON.stringify(draft)) <= 512`, so newline, control and surrogate escapes cannot inflate the level. `compaction.droppedFields` names every clipped or dropped field; `truncated`/`originalTokens`/`returnedTokens` record the cut. `what was tried` is dropped first; boundaries, constraints, objective and output format survive unless the serialized ceiling cannot be met, in which case each is trimmed in that order. `boundChildBrief` throws if the ceiling still cannot be met. |
| Resume L1 (redo) | Reruns the brief from scratch. Honored **only** on an explicit parent request; restores the brief alone. |
| Resume L2 (resume) | Reopens the live child session and adds an instruction. Default while the child session is alive; restores the brief and the child session, never the journal. `task.resume(sessionID, instruction)` is the contract but has no live handle yet (#602); `childSession` is always named, or the plan is `session_missing` rather than a blind reopen. |
| Resume L3 (rebuild) | Rebuilds the brief from the artifact plus the ledger interval in `source_refs`. Automatic fallback when the session is gone; restores the brief and the journal, never the child session. |
| Level parsing | `requested` is matched against exactly `L1`, `L2` or `L3`. Any other value (including `l1`, `L4` or `L1 `) throws `invalid resume level; use L1, L2 or L3`; it never falls through to L3. |
| Missing context | L1 without an artifact resumes from the live parent's in-memory brief and restores nothing from the ledger; L3 without an artifact is `artifact_missing`; L2 without a session id is `session_missing`; a resume never invents context. |
| Scope | The child inherits tools, round and turn ceilings from the parent (I-01/I-02); a child never spawns a grandchild. |
| Communication | Default is parent-mediated (I-18): a child returns to the parent. The opt-in bus below never replaces that path. |
| Message bus | `task.bus: true` opts one run in; the harness creates one in-memory bus for the parent run and registers only direct children (depth one). `agent_message` is the only door and must be allowlisted on both sides (I-01): `send` takes one exact sibling name and one bounded note or an artifact ref, `inbox` drains. No broadcast (`*`, `all`, lists), no parent address, no agent outside the run's declared roster, no agent without `agent_message` in its effective allowlist (`bus_target_unavailable`), no agent name with more than one live execution (`bus_ambiguous_recipient`), no note above 500 chars/1 KiB, and no more than 32 messages/8 KiB per run. Every sent message is copied to the parent as a sanitized `agent.message` audit event (I-03/I-04), with the body redacted of secrets and control characters. A message is data: it cannot add a tool, raise a permission or persist an approval; a note to an eligible agent that never starts stays queued in the run. |

`planChildResume` resolves the level and its `restored` list; no level ever restores the parent transcript. The live-session execution of L2 is open on the reopened #602, because a child transcript is intentionally never persisted.

## Consequences

- Gain: child failures leave a bounded, auditable artifact; retries cannot silently restore more context than the chosen level.
- Cost: an exceptional child writes one extra ledger event and the artifact adds the optional `child_output_format` field to v1.
- Invariants affected: I-01/I-02 (child scope), I-03/I-04 (sanitized events), I-18 (parent-mediated communication).

## Alternatives discarded

- Persist every child transcript: violates the size rule and creates a second source of truth beside the ledger.
- Write the artifact on the happy path: duplicates the summary and pollutes the ledger with non-exceptional events.
- Implicit L1 or L2: a resume would redo or reopen without the parent asking, restoring more context than allowed.
