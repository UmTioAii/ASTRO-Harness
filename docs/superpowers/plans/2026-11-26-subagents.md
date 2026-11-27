# Background Subagents Implementation Plan

Objective: deliver immediate, bounded, read-only background delegation through `subagent`, with isolated generations and serialized parent delivery.

| Covers | Does not cover |
|---|---|
| Two-phase contracts, runtime, lifecycle, composition, compatibility and acceptance | Writer/coding delegation, child worktrees, daemons, crash recovery, grandchildren and generic parallel tools |

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Architecture:** An explicit process runtime owns parent epochs, admission and generation workers; a per-parent driver serializes user turns and coalesced wakes. A generation factory owns provider, executor, MCP and account lease resources, while the tool and legacy `task` adapters share foreground delivery.

**Tech Stack:** Bun >=1.4, strict TypeScript, existing ledger/audit/locks, Ink/React TUI; no new runtime dependency. **Spec:** `docs/superpowers/specs/2026-11-25-subagents-design.md` (approved 2026-11-26). **Status:** Approved on 2026-11-26; subagent-driven execution selected.

## Global Constraints

- Read the spec, `AGENTS.md` and `docs/implementation-guide.md`; preserve every status, limit and compatibility requirement.
- Start in a clean isolated worktree from updated `main`; exclude all unrelated working-tree changes and select the real issue first.
- Use one task per branch/PR, target 200 changed lines, ceiling 400; Phase 2 starts after Phase 1 is reviewed and merged.
- Commit failing tests (`test:`) before implementation (`feat:`/`fix:`), with `Refs #n`; record RED output in each PR.
- Before every PR run `bun test` and `bun run typecheck`; every PR receives fresh security and correctness reviews.
- Background defaults true; depth one; every resolved target is read-only and most-restrictive scoped; global `agents.maxActive` default two and this project three; one queued follow-up.
- Timeouts are 1–110,000 ms with manifest 120,000 ms; payloads 8 KiB, batches 32 KiB and inbox 32 entries.
- Root/spawn reservations are process-local per parent epoch; only account concurrency crosses processes through the ledger.
- Replace/filter all `subagent` call arguments/results to ID/generation/hash/delivery metadata before any derived persistence; never persist prompts, transcripts, payloads or free-form errors; no daemon or automatic restart resume.
- Shared `cwd` is not filesystem isolation; I-10 permits read-only children only, with no child worktrees, writer locks or claim of conflict-free parallel writes.
- Update owning docs in the same task as their behavior; repository language is English, docs <=150 lines and ADRs <=60 lines.

## Review Focus

- Fixed-envelope tokens + 1, secrets and XML terminators must yield safe parseable JSON: Tasks 1 and 4.
- Foreign/stale IDs and close during suspended generation/account admission must not mutate or orphan work: Tasks 2, 3 and 7.
- Pause/cancel with a queued prompt and simultaneous wait/observer settlement must produce one outcome: Tasks 3, 4 and 8.
- Failed wakes, continuous user input and restart must not loop, starve user turns or reconstruct payloads: Tasks 5 and 9.
- Same-account fallback, late approvals and delivered paused outcomes must preserve identity and block unsafe handoff: Tasks 7, 8 and 9.

## Phase 1 — Core contracts and delivery
**File map:** `src/subagents/{types,runtime,coordinator,delivery}.ts`, `src/tools/{subagent,executor,types}.ts`, `src/output-limit.ts` and focused tests.
### Task 1: Public tool contract and safe envelope
**Files:** Create `src/subagents/types.ts`, `src/tools/subagent.ts`, `tests/subagent-tool.test.ts`; modify `src/tools/types.ts`, `src/tools/executor.ts`, `src/output-limit.ts`.
**Interfaces:** Consumes existing tool/permission/shell types; produces `SubagentOperation`, closed `SubagentErrorCode` (exactly spec §2), closed discriminated `SubagentResult` (`isError: false`, `code?: never` | `isError: true`, `code`) with spec IDs/status/payload fields, `SubagentCallContext`, `ParentExecutionSnapshot`, `ParentSubagentRuntime.execute(operation, context): Promise<SubagentResult>`, `createSubagentTool(deps: { runtime: ParentSubagentRuntime; snapshot(): ParentExecutionSnapshot }): Tool` and `ToolResult.transient?: true`.
- [ ] RED: test exact closed `oneOf` variants/fields, lengths, generation/background/timeout rules and manifest; through real `ToolExecutor` at `outputLimitTokens = estimateTokens(JSON.stringify(baseResult)) + 1`, assert parseable IDs/status/`isError`/code/`truncated`, direct `ToolResult.isError`/JSON mapping, `transient` and no artifact despite secrets/XML; assert ordinary `status: "failed"` execution results map to `isError: true`/`code: "child_failed"` in result, JSON and `ToolResult`.
- [ ] Run `bun test tests/subagent-tool.test.ts`; expect FAIL because the tool/envelope limiter is absent.
- [ ] Commit `test: add subagent contract RED` with `Refs #n`.
- [ ] Implement the parser/result union/serializer, direct `ToolResult` mapping and `limitSubagentEnvelope(result, capTokens)`; preserve code while truncating nested payload only and bypass generic head/tail/artifact handling.
- [ ] Run `bun test tests/subagent-tool.test.ts tests/output-limit.test.ts tests/tools-contract.test.ts`; expect 0 failures.
- [ ] Commit `feat: add subagent tool contract` with `Refs #n`.
### Task 2: Parent epochs and immediate admission
**Files:** Create `src/subagents/runtime.ts`, `tests/subagent-runtime.test.ts`; amend the runtime section of `docs/adr/0008-spawn-de-subagente-em-runtime.md`.
**Interfaces:** Produces `createSubagentRuntime(deps)`, `openParent({ parentSessionID, deliver })`, immutable process-local `ChildResumeState = Readonly<{ messages: ChildTurn["messages"]; checkpoint?: ChildTurn["checkpoint"] }>`, `OpenGenerationRequest { snapshot, childSessionID, generation, executionRunID, agentExecutionID, agent, description, promptHash, signal: AbortSignal, resume?: ChildResumeState }`, `ChildTurn { final, messages, checkpoint?, pauseReason? }`, unchanged `ChildGeneration.run(prompt, signal)`/`close()` and `SubagentRuntimeDeps.openGeneration(request)`; create returns `running` after reservation/registration/observer installation.
- [ ] RED: with cap three and no `spawn.parallel`, hold two generation gates and prove immediate `running` plus both workers in flight; cover observer-before-start, fast completion, identities, parent-inclusive root/spawn caps across turns/accounts, hash-only audit, rollback/no post-close start at every boundary, and abort/foreground-timeout/close signaling while `openGeneration` admission is suspended.
- [ ] Run `bun test tests/subagent-runtime.test.ts`; expect FAIL because runtime/admission are absent.
- [ ] Commit `test: add subagent admission RED` with `Refs #n`.
- [ ] Implement tracked operations, admission-lifetime signal propagation, atomic root/spawn check-and-reserve, registration/observer before start, generation-safe cleanup and idempotent bounded close with `close_timeout`.
- [ ] Run `bun test tests/subagent-runtime.test.ts tests/subagent-tool.test.ts`; expect 0 failures.
- [ ] Commit `feat: add immediate subagent admission` with `Refs #n`.
### Task 3: Serial workers, control and outcomes
**Files:** Create `src/subagents/coordinator.ts`, `tests/subagent-coordinator.test.ts`; modify `src/subagents/runtime.ts`, `tests/subagent-runtime.test.ts`.
**Interfaces:** Produces complete create/continue/wait/cancel execution, `enqueueOrStart`/`finishIfQueueEmpty`, statuses, one outcome and stable errors; coordinator owns Task 2 `ChildResumeState`, passes `resume?` without changing `ChildGeneration.run`, retains it on failed admission and consumes/replaces it only at admission start immediately before `run`.
- [ ] RED: cover follow-up/finish, queue-full before reservation, cancel/settle/follow-up, queued drops, cumulative ceilings, stale/foreign IDs, repeated cancel, independent wait cancellation, sibling isolation, hash-only audit, paused/completed history+checkpoint transfer, failed-admission retention and the single successful-start consume/replace boundary.
- [ ] RED: through real `ToolExecutor`, delay admission/start and prove total `foreground_timeout`, `cancelling`, no wake and later retrieval; contrast ordinary cancel (`isError:false`, no code) with timeout (`isError:true`, stable code), map provider/executor throws to `status: "failed"`/`code: "child_failed"`, and verify every transition plus no settled slot.
- [ ] Run `bun test tests/subagent-coordinator.test.ts tests/subagent-runtime.test.ts`; expect FAIL on missing coordination/control.
- [ ] Commit `test: add subagent coordination races RED` with `Refs #n`.
- [ ] Implement the serial coordinator, one queued follow-up, owned resume-state commit/rollback, generation transitions, total foreground deadline and `queuedFollowUpDropped` on the sole outcome.
- [ ] Run `bun test tests/subagent-coordinator.test.ts tests/subagent-runtime.test.ts tests/subagent-tool.test.ts`; expect 0 failures.
- [ ] Commit `feat: coordinate subagent generations` with `Refs #n`.
### Task 4: Atomic outcome inbox and notifications
**Files:** Create `src/subagents/delivery.ts`, `tests/subagent-delivery.test.ts`; modify `src/subagents/runtime.ts`.
**Interfaces:** Produces `OutcomeRecord`, `DeliveryState`, `createParentInbox()`, `ParentInbox.claim(record)` and `wait(sessionID, generation, signal, timeoutMs): Promise<SubagentResult>`; runtime wait/observer delivery consumes this inbox.
- [ ] RED: cover waiter/observer in both orders, shared multiple waiters, stale observers, foreground preclaim/no wake, wait timeout without claim, distinct generations, 32-entry overflow without loss, 8/32-KiB limits, redaction and escaped `</background-result>`.
- [ ] Run `bun test tests/subagent-delivery.test.ts`; expect FAIL because the atomic inbox is absent.
- [ ] Commit `test: add subagent inbox races RED` with `Refs #n`.
- [ ] Implement `unclaimed/inbox-claimed/wait-claimed/delivered/deferred` arbitration, bounded deferred records and sanitized notification serialization; only inbox claims may wake/defer.
- [ ] Run `bun test tests/subagent-delivery.test.ts tests/subagent-coordinator.test.ts`; expect 0 failures.
- [ ] Commit `feat: add atomic subagent outcome inbox` with `Refs #n`.
### Task 5: Serial ParentDriver and wake rearm
**Files:** Modify `src/subagents/delivery.ts`, `tests/subagent-delivery.test.ts`.
**Interfaces:** Produces `ParentDriver.submitUser(prompt, options)`, `enqueue(record)`, `pump(): Promise<void>` and `createParentDriver({ submitUser, submitSynthetic })`; consumes Task 4 records and injects real parent-turn functions.
- [ ] RED: prove user FIFO precedence, safe-boundary coalescing, pump after every outcome, failed wake → no immediate retry → a subsequent user prompt or explicit `subagent` call → retry, no rearm from passive child activity, overflow rearm with capacity, no synthetic self-rearm/starvation, parent maxTurns/budget/permission enforcement and hash-only wake audit.
- [ ] Run `bun test tests/subagent-delivery.test.ts`; expect FAIL on missing driver/rearm behavior.
- [ ] Commit `test: add parent driver delivery RED` with `Refs #n`.
- [ ] Implement one serial pump for user/synthetic submissions, real-turn wakes and qualified rearm; model delivery is at-least-once, never exactly-once after crash.
- [ ] Run `bun test tests/subagent-delivery.test.ts tests/subagent-coordinator.test.ts`; expect 0 failures.
- [ ] Commit `feat: serialize parent subagent wakes` with `Refs #n`.
## Phase 2 — Execution and product integration
**File map:** `src/subagents/{catalog,execution}.ts`, app/session/CLI/TUI/handoff adapters, owning ADRs/docs and integration suites.
### Task 6: Read-only catalog, scope and governance
**Files:** Create `src/subagents/catalog.ts`, `tests/subagent-catalog.test.ts`; modify `src/core/config.ts`, `astro.config.json`, `docs/adr/0037-per-account-concurrency-and-bounded-agents.md`.
**Interfaces:** Produces `resolveSubagentAgent(name, registry): AgentEntry` and `captureParentExecutionSnapshot(input): ParentExecutionSnapshot`; every built-in/configured/same-name result is read-only and most-restrictive parent/target scoped, initially and for later generations.
- [ ] RED: assert effective-parent model/profile inheritance for built-ins and restrictive tools/permissions+mode/ceilings/path+protected-path/shell+sandbox for every target; include a configured target broader than its parent (write/shell/ceilings), unknown plugin/MCP fail-closed, narrower `explore`, same-name precedence, task/handoff/config/`multiAgentRun` exclusion, no child delegation, immutable/narrowed generations, cumulative ceilings and caps two/three; also assert no default/public registration or explicit-tools early activation, while retaining the write/network manifest and deny-by-default.
- [ ] Run `bun test tests/subagent-catalog.test.ts`; expect FAIL on missing catalog/governance.
- [ ] Commit `test: add subagent scope governance RED` with `Refs #n`.
- [ ] Implement catalog/snapshot narrowing without adding `DEFAULT_AGENT_TOOLS` or public registration; set only project `agents.maxActive: 3` and amend ADR-0037, never I-10.
- [ ] Run `bun test tests/subagent-catalog.test.ts tests/config.test.ts tests/config-preset.test.ts tests/config-overlay.test.ts tests/task-tool.test.ts`; expect 0 failures.
- [ ] Commit `feat: add scoped read-only subagent catalog` with `Refs #n`.
### Task 7: Generation resources and cross-process account identity
**Files:** Create `src/subagents/execution.ts`, `tests/subagent-execution.test.ts`; modify `src/core/app.ts`, `src/core/session.ts`, `src/agent-lock.ts` only where the adapter requires.
**Interfaces:** Produces `createSubagentGenerationFactory(deps): (request: OpenGenerationRequest) => Promise<ChildGeneration>`; consumes Tasks 1–6, honors `request.signal` throughout account acquisition/resource assembly, reads but never mutates `request.resume`, and preserves `ChildTurn`/`ChildGeneration.run` unchanged.
- [ ] RED: return parent `runTask` while two child provider gates stay open; assert no cleanup before generation close, abort/foreground-timeout/close during suspended account acquisition, two-process caps, same-account fallback identity, `approveSwap`, rollback, fail-closed quota, late `(executionRunID, ledgerSeq)` dedupe, sibling isolation and hash-only audit.
- [ ] RED: integrate the real factory and coordinator to prove prior messages/checkpoint transfer into a new generation and failed-admission retention of the prior paused/completed resume state; successful start consumes/replaces it only at the Task 3 boundary.
- [ ] Run `bun test tests/subagent-execution.test.ts tests/agent-lock.test.ts`; expect FAIL because detached ownership is absent.
- [ ] Commit `test: add subagent resource ownership RED` with `Refs #n`.
- [ ] Extract signal-aware child assembly into generation-owned provider/executor/MCP resources and held account lease; never mutate resume state or detach a Promise over parent-owned resources.
- [ ] Run `bun test tests/subagent-execution.test.ts tests/agent-lock.test.ts tests/agent-lock-run.test.ts tests/agent-lock-config.test.ts tests/task-app.test.ts`; expect 0 failures.
- [ ] Commit `feat: own subagent generation resources` with `Refs #n`.
### Task 8: Scoped FIFO approvals and resumable pause
**Files:** Modify `src/tui/approvals.ts`, `src/chat/approvers.ts`, `src/tools/executor.ts`, `tests/tui-approvals.test.ts`, `tests/approval-timeout.test.ts`.
**Interfaces:** Produces `ApprovalRequestKey { parentSessionID, childSessionID?, generation?, run, agent, callId }`, `ApprovalDrainScope = "foreground" | { kind: "generation"; sessionID; generation } | { kind: "parent" }` and `ApprovalBridge.drain(scope): Promise<void>`.
- [ ] RED: hold two approvals, answer FIFO with exact routing, retain runner/slot until decision/timeout, discard late responses, drain foreground/generation/parent scopes independently, preserve background approval on ESC, produce resumable non-TTY permission/no-progress `paused` with slot release and no retries, and audit approval/pause with hashes only.
- [ ] Run `bun test tests/tui-approvals.test.ts tests/approval-timeout.test.ts`; expect FAIL on single-slot pending state/missing scopes.
- [ ] Commit `test: add concurrent approval routing RED` with `Refs #n`.
- [ ] Implement keyed FIFO, abort/timeout settlement and scoped draining without changing approval policy.
- [ ] Run `bun test tests/tui-approvals.test.ts tests/approval-timeout.test.ts tests/approval.test.ts tests/subagent-coordinator.test.ts`; expect 0 failures.
- [ ] Commit `feat: route concurrent subagent approvals` with `Refs #n`.
### Task 9: Epoch lifecycle, safe persistence and handoff
**Files:** Modify `src/chat/agent-session.ts`, `src/chat/export.ts`, `src/core/session.ts`, `src/core/app.ts`, `src/cli.ts`, `src/tui/commands.ts`, `src/handoff/lifecycle.ts` and compaction persistence as needed; create `tests/subagent-session.test.ts`; modify handoff/export/compaction/resume tests, ADR-0036 and `docs/invariants.md`.
**Interfaces:** Produces optional/inert `AgentSessionOptions.subagents?: SubagentRuntime`, `RunOptions.subagents?: ParentSubagentRuntime`, async idempotent `clear(): Promise<void>`/`resume(snapshot: SessionSnapshot): Promise<void>` and `MultiAgentSessionOptions.subagents?: ParentSubagentRuntime`; consumes Tasks 1–8 and existing preflight, with no public registration, driver activation or explicit-tools bypass.
- [ ] RED: cover epoch close/restart without reconstruction and handoff `children_active`/checkpoint/preflight/`close_timeout` guards; use prompt canaries through snapshot/resume/export/compaction for create+continue arguments/results in foreground+background and notification/wait/automatic turns, allowing only ID/generation/promptHash/delivery metadata and proving `transient` alone insufficient.
- [ ] Run `bun test tests/subagent-session.test.ts tests/handoff-session.test.ts tests/chat-export.test.ts tests/compaction-session.test.ts`; expect FAIL on lifecycle/persistence guards.
- [ ] Commit `test: add subagent epoch and persistence RED` with `Refs #n`.
- [ ] Implement epoch invalidation, centralized call/result persistence filtering and handoff refusal without ownership/checkpoint transfer; keep runtime hooks optional/inert and update ADR-0036/affected invariants, never I-10.
- [ ] Run `bun test tests/subagent-session.test.ts tests/handoff-session.test.ts tests/handoff-approval.test.ts tests/chat-export.test.ts tests/compaction-session.test.ts tests/resume.test.ts tests/resume-run.test.ts`; expect 0 failures.
- [ ] Commit `feat: guard subagent epochs persistence and handoff` with `Refs #n`.
### Task 10: Process composition, registration and activation
**Files:** Modify `src/core/app.ts`, `src/core/config.ts`, `src/chat/agent-session.ts`, `src/cli.ts`, `src/tui/run.tsx`, `src/tui/turn.ts`, `tests/subagent-session.test.ts`, `docs/decisions.md`, `docs/invariants.md`, ADR-0008; create `tests/subagent-e2e.test.ts`.
**Interfaces:** Activates Task 9 runtime options and idempotent `AgentSession.close(): Promise<void>`; composes Tasks 1–9 without globals, then really registers `subagent` and adds it to defaults only after Task 9 guards; explicit `agent.tools` follows the same sequencing.
- [ ] RED: before composition/activation, spawn real `bun run dev` with fake TTY, cap three and no `spawn.parallel`; require two provider requests in flight before either release (IDs alone fail), bounded results/wakes, foreground/wait cancellation independence and clean shutdown; also cover one runtime/driver, TUI/REPL rendering, pump/ESC/close semantics and a default-configuration `runTask` smoke.
- [ ] Run `bun test tests/subagent-session.test.ts tests/subagent-e2e.test.ts tests/chat-agent-session.test.ts tests/tui-run.test.ts`; expect FAIL on missing composition/registration/overlap.
- [ ] Commit `test: add subagent composition and dev-path RED` with `Refs #n`.
- [ ] Compose runtime/driver and all sends, register/activate the tool only behind Task 9 guards, await ordered close in every adapter, and amend D-07/I-01/ADR-0008 without changing I-10.
- [ ] Run `bun test tests/subagent-session.test.ts tests/subagent-e2e.test.ts tests/chat-agent-session.test.ts tests/chat-session-commands.test.ts tests/tui-run.test.ts tests/tui-sessions.test.ts tests/config.test.ts tests/task-app.test.ts`; expect 0 failures.
- [ ] Commit `feat: compose register and activate subagents` with `Refs #n`.
### Task 11: Legacy task runtime adapter
**Files:** Create `tests/task-runtime-adapter.test.ts`; modify `src/tools/task.ts`, `src/core/app.ts`, `docs/adr/0008-spawn-de-subagente-em-runtime.md` and existing task characterization suites only for intentional interface updates.
**Interfaces:** Produces `createTaskRuntimeAdapter(runtime): Pick<TaskToolDeps, "delegate">`; retains the existing `resume` path, `TaskDelegation`, `TaskResumeOutcome`, artifact lookup, L1/L2/L3, fan-out signatures and `task.session_id` unchanged.
- [ ] RED: through the real composed app/task adapter, characterize delegate foreground preclaim, IDs/errors, serial/fan-out/accounting and zero wakes, plus unchanged existing resume/artifact lookup/L1/L2/L3/eviction/32-handle behavior; keep spawn/handoff/resume/lock suites as green baselines.
- [ ] Run `bun test tests/task-runtime-adapter.test.ts tests/task-tool.test.ts tests/task-app.test.ts tests/task-fanout.test.ts tests/task-fanout-app.test.ts tests/task-handoff-integration.test.ts`; expect FAIL only because the adapter is absent.
- [ ] Commit `test: add legacy task runtime adapter RED` with `Refs #n`.
- [ ] Wire only legacy `delegate` with foreground preclaimed delivery, preserving `spawn.parallel`, per-run accounting and L3 rebuild; do not replace/wire `resume`, expose built-ins to `task`, or omit ADR-0008 compatibility text.
- [ ] Run the same six task suites plus `tests/subagent-delivery.test.ts tests/resume.test.ts tests/resume-run.test.ts tests/agent-lock.test.ts`; expect 0 failures and no automatic wake.
- [ ] Commit `feat: unify legacy task foreground delegation` with `Refs #n`.
### Task 12: Final acceptance, reusable smoke and release notes
**Files:** Create `scripts/subagent-smoke.ts`, `docs/subagents-migration.md`; modify `docs/INDEX.md` and `README.md` only for the user-facing tool/migration link; reuse Task 10 `tests/subagent-e2e.test.ts`.
**Interfaces:** Reuses `tests/integration/helpers.ts` and `scripts/packed-smoke-tty.ts`; smoke exits nonzero unless two gated provider requests overlap through `bun run dev`.
- [ ] Rerun the Task 10 real dev-path E2E as final GREEN acceptance, including overlap, bounded wakes/results, foreground/wait cancellation independence and clean shutdown; do not demand failure from the completed path.
- [ ] Add the reusable smoke, migration documentation and concise release notes without widening scope.
- [ ] Require a fresh focused RED and recorded failure for any newly discovered product fix; otherwise change no production/tests in this task.
- [ ] Run `bun test tests/subagent-e2e.test.ts`, then `bun test` and `bun run typecheck`; expect 0 failures/type errors.
- [ ] Commit `docs: add subagent smoke and migration notes` with `Refs #n`; commit any conditional fix separately after its RED.
- [ ] Obtain fresh security and correctness reviews on the integrated diff; resolve High/Critical findings before merge.
