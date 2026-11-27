# Background subagent runtime

Objective: define immediate, bounded background delegation with isolated child context and serialized parent delivery.

| Covers | Does not cover |
|---|---|
| Read-only `subagent`, its runtime, ownership, notifications, limits and compatibility | Daemon, crash recovery, grandchildren, P2P/teammates, writer/coding delegation, child worktrees, generic parallel tools |

- Status: approved on 2026-11-26 after independent security and correctness reviews; implementation requires a separate approved plan.
- References: ADR-0008, ADR-0036, ADR-0037; I-01/I-02/I-03/I-04/I-07/I-08/I-10/I-12/I-17/I-18/I-19.

## 1. Decisions and invariants

- One explicit `SubagentRuntime` is composed per CLI/TUI process and injected; no hidden singleton or daemon.
- A parent session owns only its direct children. Another parent cannot query, continue, wait for or cancel them.
- Depth is one. Children never receive `subagent`, `task`, `spawn_agent`, `handoff` or `agent_message`.
- Background is the default for `subagent`; foreground is optional. `spawn.parallel` remains legacy `task` fan-out policy.
- Within one parent epoch and process, the parent and every non-settled child generation count toward the root active cap across accounts and turns. Root admission is process-local; only account concurrency is coordinated across processes. Legacy serial `task` keeps its existing admission policy.
- A generation has one worker, one execution run, one provider/lock identity and one settled outcome.

## 2. Public tool contract

`subagent` uses a closed JSON `oneOf`; every variant has `additionalProperties: false`.

| Variant | Required fields | Optional fields | Forbidden combinations |
|---|---|---|---|
| Create | `agent`, `description`, `prompt` | `background`, `timeoutMs` | `sessionID`, `generation`, `action`; `timeoutMs` requires `background: false` |
| Continue | `sessionID`, `prompt` | `background`, `generation`, `timeoutMs` | `agent`, `description`, `action`; `timeoutMs` requires `background: false` |
| Wait | `action: "wait"`, `sessionID` | `generation`, `timeoutMs` | `prompt`, `agent`, `description`, `background` |
| Cancel | `action: "cancel"`, `sessionID` | `generation` | `prompt`, `agent`, `description`, `background`, `timeoutMs` |

- `background` defaults to `true`. A successful background create/continue returns `status: "running"` after reservation, registration and observer installation, without awaiting the child response. `sessionID` is intentionally distinct from legacy `task.session_id`.
- IDs and agent names are non-empty strings (maximum 64); description is 1–160 and prompt 1–32,000 characters.
- `generation` is a positive integer. If omitted on continue/wait/cancel, the current generation is captured at linearization.
- `timeoutMs` is an integer from 1 to 110,000, default 30,000. Wait timeout returns the current non-settled status without error or claim. Every admission/start wait honors the tool abort signal; foreground timeout is a total budget from tool entry and also bounds those waits.
- Create/continue with `background: false` means start plus local wait. On expiry it requests cancellation and uses the remaining manifest margin to return `isError: true`, `code: "foreground_timeout"`, `status: "cancelling"` and IDs; it never silently becomes background.
- `SubagentResult` is a closed discriminated success/failure union: non-error results, including `running`, `cancelled` and `paused`, have `isError: false` and no `code`; failures, including `foreground_timeout`, have `isError: true` and a closed `SubagentErrorCode code`.
- `SubagentErrorCode` is exactly `invalid_request`, `unknown_agent`, `session_missing`, `ownership_denied`, `generation_stale`, `child_failed`, `child_settling`, `child_queue_full`, `spawn_limit_exceeded`, `account_locked`, `children_active`, `foreground_timeout` or `close_timeout`.
- Every accepted job/control result is JSON in `ToolResult.output` and contains `sessionID`, `generation`, `status`; settled results also contain bounded `output` or `error` and `truncated`. Validation errors may lack IDs.
- `ToolResult.isError` equals `SubagentResult.isError`; JSON output retains `isError` and failure `code`, including after truncation. Ordinary child/provider/executor execution outcomes with `status: "failed"` use `isError: true` and `code: "child_failed"`; ordinary cancellation has no code, unlike foreground timeout.
- Public statuses are `running`, `waiting`, `cancelling`, `settling`, `completed`, `failed`, `cancelled`, `paused`; admission's `starting` state is internal and never returned.
- Active transitions are `running ↔ waiting`, `running|waiting → cancelling`, and `running|waiting|cancelling → settling` when `runSession` finishes, before resource release and outcome publication. `settling` reaches exactly one settled outcome.
- `completed`, `failed`, `cancelled` and `paused` are settled outcomes; `paused` has a checkpoint/reason and is resumable only by an explicit new generation.
- Manifest: `risk: medium`, `permission: write`, `class: read_common`, `timeoutMs: 120000`, `retryable: false`, `idempotent: false`, `sideEffects: network`. Read-only child narrowing never reclassifies `subagent` itself because delegation has network/side effects.

## 3. Catalog, scope and governance

- Delegation-only `general` and `explore` resolve outside `Registry`; they never become `config.agents`, `task` targets or handoff targets and do not activate `multiAgentRun`. A configured same-name agent takes precedence only for `subagent`.
- Built-ins inherit the effective parent model/profile. Every resolved target—built-in, configured or same-name override—receives the most restrictive parent/target intersection of tools, permissions/mode, ceilings, path/protected-path and shell/sandbox policy, both initially and on every later generation, and is further narrowed to read-only tool manifests. Unknown plugin/MCP manifests fail closed; `explore` may remain narrower by role/catalog policy. Write-capable children and child worktrees are deferred, so this phase has no coding/writer delegation.
- A create captures a `ParentExecutionSnapshot`; existing generations never follow `/model` or config reload. New generations revalidate scope against the current parent and cannot exceed the original child scope. Any provider/model/credential change between generations requires the existing `approveSwap` gate.
- Child counters for steps, turns and budget are cumulative across follow-ups and generations; no follow-up resets a ceiling.
- Only after runtime registration and epoch/snapshot/handoff guards, `subagent` is added to `DEFAULT_AGENT_TOOLS` as an intentional governance change. Implementation must amend D-07/I-01 documentation and ADR-0008, and provide migration/release notes. Explicit `agent.tools` remains deny-by-default and cannot activate the tool before those guards.
- The implementation for this project must set `agents.maxActive: 3`; global defaults remain two. This raises its explicit account tier through ADR-0037, but does not replace root admission or other-process locks.
- `spawn.maxActive` remains a separate spawn budget: for `subagent`, an atomic process-local reservation scoped to the parent epoch, with one unit per new generation and none for a running follow-up. Legacy `task` keeps its existing per-run accounting.

## 4. Admission, identity and resources

| Identity/resource | Contract |
|---|---|
| Parent | Stable `parentSessionID`; its open epoch counts as one in-memory root slot, even idle, until parent close |
| Child | Stable public `childSessionID`; monotonically increasing `generation`; each non-settled generation holds its root reservation |
| Execution | New unique `executionRunID` and lock `agentExecutionID` per generation; never reuse a completed run; cleanup verifies generation ownership |
| Admission | `OpenGenerationRequest` carries an admission-lifetime `signal: AbortSignal`; track the operation before any reservation, serialize closing and the atomic process-local root/spawn check-and-reserve, acquire the worker's account lease and assemble resources while honoring that signal, register job/controller/observer, recheck closing, then start |
| Rollback | Any failure or closing before start releases every reservation and leaves no handle, observer, inbox entry or provider call |
| Account | Final acquisition uses the ledger file lock and is the only cross-process execution cap; precheck refusal is `spawn_limit_exceeded`, a later race is `account_locked` |
| Provider | Every generation gets its own executive provider, including same-account children; fallback/move uses child execution identity |
| MCP/tools | Each generation owns its executive provider, `ToolExecutor` and MCP registry; only ledger/audit/config snapshots are shared. A parent `runTask` never closes detached-job resources |
| Ledger/audit | Shared sanitized infrastructure; usage is deduplicated by `(executionRunID, ledgerSeq)` so late entries are neither omitted nor counted twice in session totals |

Waiting for an interactive decision retains the runner and slot until decision/timeout. Non-TTY permission/no-progress pauses stop safely, release the slot and require explicit resume. Settled-but-undelivered results consume no active slot.

## 5. Workers, parent delivery and control

- A child coordinator serializes `enqueueOrStart` and `finishIfQueueEmpty`. The last inbox check and settlement are one linearized operation.
- A worker drains accepted follow-ups after the current `runSession` boundary, never concurrently. Follow-up during `cancelling`/`settling` returns `child_settling` and accepts nothing; after a settled outcome it starts a new generation.
- The runtime/coordinator owns immutable process-local `ChildResumeState` carrying prior messages and an optional checkpoint, supplied through `OpenGenerationRequest.resume?`; the factory never mutates it. Failed admission leaves the prior paused/completed state resumable; successful start consumes/replaces it at the admission-start boundary immediately before `ChildGeneration.run(prompt, signal)`, whose signature remains unchanged.
- An active child accepts at most one queued follow-up. Further calls fail before enqueue with `child_queue_full`, without consuming a generation or spawn reservation. Pause, cancellation and close discard the queued prompt without starting it or creating a second outcome; the generation's single outcome reports `queuedFollowUpDropped: true`, and the parent must explicitly reissue it.
- A foreground call and legacy `task` preclaim local delivery and never create an automatic wake. A foreground timeout leaves the outcome retrievable by explicit `wait`, still without a wake. Their adapters preserve existing IDs, output order, serial/parallel policy, L1/L2/L3 and 32-handle behavior.
- Each settled outcome record has `(parent, childSessionID, generation)` and atomic delivery states `unclaimed`, `inbox-claimed`, `wait-claimed`, `delivered`, `deferred`; only an inbox claim can deliver an automatic wake or become deferred.
- A registered waiter wins an unclaimed settled record; otherwise the observer claims inbox delivery. Once inbox-claimed, `wait` may read the result but cannot retract the notification. Multiple waiters share the immutable result.
- One `ParentDriver` per parent owns all user and synthetic submissions. TUI and REPL adapters must use it and render automatic turns; snapshot persistence is limited to allowed ID/generation/promptHash/delivery metadata. Its pump runs after every turn outcome, including error and cancellation.
- User prompts retain FIFO and have precedence over automatic wakes. Notifications arriving during work are coalesced at the next safe boundary; different generations of one child remain distinct.
- Each wake is a real turn subject to parent maxTurns, budget, permissions and audit. A failed wake becomes `deferred` and rearms only after that turn ends and a subsequent user prompt or explicit `subagent` call arrives, never from its own error pump. Inbox overflow rearms at a later safe boundary with capacity. Model delivery is at-least-once on retry; no exactly-once claim survives crash.
- Notifications use harness metadata plus sanitized, bounded JSON payload, XML-escaped if wrapped in `<background-result>`. Child text is always untrusted data.
- Limits are 8 KiB per nested result payload, 32 KiB per batch and 32 inbox entries. Overflow is marked `truncated` or `deferred`; settled records are not silently discarded.
- Envelope-aware truncation also fits the executor's remaining token budget after the fixed JSON envelope. It preserves valid JSON and required IDs/status/code/`truncated`; the generic head/tail/artifact limiter cannot rewrite or persist a `subagent` payload.
- Before snapshots, exports, compaction or any other derived persistence, replace/filter every `subagent` tool-call argument and result, for every variant and both modes, to allowed ID/generation/promptHash/delivery metadata; `ToolResult.transient` alone is insufficient. Only task/prompt hashes survive, never free prompt text. Notification, explicit `wait`, foreground and automatic-turn content remains process-local and is never reconstructed from a hash after restart. Pending inbox and live workers are process-local; restart loses pending notifications and never automatically resumes `subagent` generations.
- `wait` has an independent waiter signal/deadline. Cancelling a wait never cancels a background child. `cancel` is idempotent: active work returns `cancelling` until cleanup settles, while an already settled outcome is returned unchanged without another notification.
- Ordinary parent-turn cancellation cancels foreground children only; background children survive. Parent close cancels all owned generations and disables wakes.
- `/clear`, `/resume` and session replacement close the old parent epoch, cancel its children and invalidate pending deliveries. Existing child snapshots never migrate implicitly.
- Handoff returns `children_active` while any owned child's current generation is non-settled or `paused`, or any owned generation has an undelivered notification. Paused checkpoints are consumed/replaced only by successful generation start or discarded by explicit parent close/clear/resume/session replacement, never by an admitted handoff, and never transfer. Receiver account/scope preflight happens before emitter destruction; ownership is never transferred implicitly.
- Interactive approvals use a per-UI FIFO broker keyed by parent, child, generation, run, agent and call ID. Each response resolves only its request. `runtime.close()` drains requests owned by the closing parent; `subagent.cancel` drains only its child/generation; ordinary parent-turn cancellation drains foreground requests only. Late UI responses are stale and resolve nothing. Non-TTY pending and no-progress never become automatic retries or indistinct failures.
- `runtime.close(): Promise<void>` is idempotent: mark closing and reject new admissions/wakes, await every tracked admission to register or roll back, cancel registered controllers, await runners/approvals/observers/compactions, close generation resources, then permit session/store close. No admission may start after observing closing. Forced shutdown is bounded and reports `close_timeout` without starting new work.

## 6. Persistence, audit and security

- Persist only task/prompt hashes, IDs, generations, caps, decisions, stable error codes and usage; never persist free prompts, child transcripts, result payloads or free-form error text. New-generation artifacts, when emitted, carry stable ID/generation/executionRunID metadata for diagnosis, not automatic restart resume.
- Audit every admission, refusal, fallback, approval, pause, cancellation, settlement and wake with sanitized metadata and hash-only prompt references.
- Global quota/budget enforcement remains ledger-based and fail-closed. Late child usage is included in parent/session reporting without double counting; no sibling failure cancels another sibling.
- Shared `cwd` is not filesystem isolation. Every child is read-only under I-10 in this phase; write-capable children, child worktrees, writer locks and coding/writer delegation are deferred, with no claim of conflict-free parallel writes.

## 7. Acceptance and delivery

- Through the real `bun run dev` TUI/`AgentSession` path, with `agents.maxActive: 3` and no `spawn.parallel`, two provider requests are both in flight before either is released; returning two IDs alone fails acceptance.
- Contract tests cover closed schemas and result/error unions, direct `ToolResult` mapping, ordinary `status: "failed"`/`code: "child_failed"` representation in result/JSON/`ToolResult`, immediate return, observer-before-start, fast completion, root/spawn caps across turns in one process, account caps across accounts and processes, rollback and same-account fallback identity.
- Race tests cover follow-up/finish, queue overflow, queued-prompt cancellation on pause/close, cancel/settle/follow-up, stale observers, wait/observer both orders, multiple waiters, coalescing, foreground without wake, and resume history/checkpoint transfer with failed-admission retention through the coordinator and real factory.
- Delivery tests prove failed wake → no immediate retry → a subsequent user prompt or explicit `subagent` call → retry, never rearm from passive child activity, overflow rearm, and valid JSON without artifact spillover through the real `ToolExecutor` at a low output limit.
- Prompt-canary snapshot/resume/export/compaction tests cover initial create and continue, foreground and background, plus notification, explicit `wait` and automatic turns; no argument, result or derived persistence retains the canary.
- Admission tests abort, foreground-timeout and close while account acquisition/resource assembly is suspended. Foreground tests use the real executor with delayed admission/start, prove the total deadline and independent background survival after wait cancellation, and contrast ordinary cancel (`isError: false`, no code) with `foreground_timeout` (`isError: true`, stable code).
- Governance tests cover FIFO approvals and scoped draining, non-TTY pause/resume, cumulative ceilings, ownership, depth, path confinement, secret/envelope injection and late usage. A configured target broader than its parent, including write/shell and ceilings, is narrowed to read-only most-restrictive scope initially and on later generations, as are built-ins and same-name overrides.
- Lifecycle tests cover every public transition, ESC, individual/repeated cancel, sibling failure, handoff refusal with a delivered `paused` outcome, receiver preflight, clear/resume epoch, close at every admission step/active state and resource cleanup after settlement.
- Existing `task`, fan-out, spawn, handoff, resume, eviction and lock suites remain characterization tests through the real composed adapter; `task` foreground never emits a subagent wake.
- Delivery requires RED→GREEN tests, `bun test`, `bun run typecheck`, a mocked-provider TUI proof, documentation/ADR updates and independent security plus correctness reviews.
