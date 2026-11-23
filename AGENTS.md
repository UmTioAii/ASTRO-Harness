# ASTRO — agent instructions

Read only this file at the start. Every other document is loaded on demand through the map in `docs/INDEX.md`.

## Project

ASTRO is a local CLI harness built with Bun + strict TypeScript, multi-provider, focused on governance: per-agent scope, cost and quota per account, approval and audit. Zero runtime dependencies (single exception: Ink/React on demand, only in the TUI opened by `astro`, ADR-0001).

## Commands

- `bun install --frozen-lockfile`
- `bun run dev` — opens the TUI from source, no build
- `bun test` — full suite
- `bun run smoke` — build + validates the launcher with Node without Bun on PATH
- `bun run smoke:packed` — `npm pack` + clean install + TUI with a loopback mock provider
- `bun run doctor` — local diagnosis (versions, deps, dist, config, credential names, ASTRO_HOME)
- `bun run typecheck` — `tsc --noEmit`
- Before any PR: `bun test` and `bun run typecheck` pass, no exceptions.

## Code map

- `src/providers/` — model adapters (openai-compat, codex-oauth)
- `src/tools/` — tools and path confinement
- `src/audit.ts`, `src/ledger.ts` — audit and cost
- `src/core/` — orchestration and contract (app, session, config, registry)
- `src/cli.ts`, `src/doctor.ts` — CLI entry point and local diagnosis
- `tests/` — mirrors `src/`

## Non-negotiable rules

Details and IDs in `docs/invariants.md`.

- A secret only enters through the local vault (ADR-0019) or a named environment variable. It never appears in a log, audit, ledger, error or prompt (I-03).
- Deny by default: a tool outside the allowlist does not run (I-01).
- A file path stays inside the `cwd` unless a rule explicitly allows otherwise (I-11, filesystem sandbox clause; the shell boundary is the rest of I-11).
- The user prompt is never persisted. Only `taskHash`.
- A behaviour change requires a test that fails first (RED) and passes after (GREEN). The RED goes into the PR description.

## Flow (summary)

**Implementing an issue? Read `docs/implementation-guide.md` first** — it has the full step-by-step (TDD, branch, PR, double review, merge).

Flow detail in `docs/workflow.md`; review checklist in `docs/review-checklist.md`.

1. Every change has an issue (`#n`). Acceptance criteria live in the issue.
2. Branch from an up-to-date `main`: `<type>/<n>-<slug>`, for example `feat/14-pool-placement`.
3. TDD is mandatory: RED (`test:`) before GREEN (`feat:`/`fix:`), separate commits, RED in the PR body.
4. Commits in the format `type: summary`, with the footer `Refs #n`.
5. PR through the template, with `Closes #n`. Target up to 200 changed lines, ceiling of 400.
6. Double review is mandatory before merge: reviewer A (security: I-03/I-01/I-11, always blocking) + reviewer B (correctness/contract), in parallel and with fresh context. See `docs/review-checklist.md`.
7. Squash merge. `main` never receives a direct commit.

## PR review (mandatory)

- No PR enters `main` without a verdict recorded in the PR itself: `Review: APPROVE` or `Review: REQUEST_CHANGES`. (PRs opened before alpha.5 used the Portuguese form `Revisão:`; the English form is the contract from now on.)
- Reviewer in fresh context: a subagent or session that receives the diff and the checklist, not the author's reasoning.
- A blocking finding cites `file:line` and a concrete failure scenario. A finding without that is a suggestion and does not block.
- A security finding (secret leak, allowlist bypass, path escape) always blocks.
- After a fix, the new review covers only the new commit, not the whole PR.

## Documentation

These rules exist to reduce the token cost of reading the project.

- One subject has one owning file. Other files link to it, they do not copy it.
- A document starts with a one-line summary. Someone who reads only the beginning decides whether they need the rest.
- Prefer tables and lists over prose. Do not repeat what is already in the code or the test.
- Reference by stable ID, never by line number: `D-13` (decision), `I-03` (invariant), `#14` (issue), `ADR-0007` (architectural decision).
- Behaviour changed? Update the affected doc in the same PR.
- Point edits. Do not rewrite a whole file to change one line.
- Limits: a doc file up to 150 lines; an ADR up to 60 lines. Above that, split.
- A new file in `docs/` enters `docs/INDEX.md` in the same PR.
- Language: **English is the repository language** — docs, ADRs, README, UI strings and error messages. Portuguese is used only for chat explanations to the maintainer. Collaboration artifacts (commits and PR/issue titles, bodies, comments) are English; chat reports are Portuguese. New code and new comments are written in English; a legacy Portuguese comment is translated when you touch the file, never as a separate sweep (see `docs/alpha.5-roadmap.md`, P7). Sole tracked exception: the alpha.5 planning set (`docs/alpha.5-roadmap.md` and `docs/superpowers/specs/2026-11-21-*.md`) stays in Portuguese and is translated in P7 (#606), because a document that still changes is cheaper to translate once.

## Do not

- Do not create a project state file (e.g. `progress.md`). State lives in issues and milestones.
- Do not add a runtime dependency without an ADR.
- Do not read all of `docs/`. Use `docs/INDEX.md` and open only what the task requires.
- Do not include a session link or a tool attribution in a commit, PR, issue, doc or log. A tool mention belongs only in a PR review, as “Claude Code”, with no model and no session.
