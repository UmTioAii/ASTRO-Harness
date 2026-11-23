# S8 — Documentation and public repository

> Objective: make the English documentation and public repository match the implemented product.

- Status: draft (alpha.5, phase P7)
- Date: 2026-11-21
- Depends on: all other specs
- Owner files: `README.md`, `docs/`, `.github/`

## 1. Language

English is the repository language: docs, ADRs, README, UI strings, error messages and new
code. Portuguese remains only in chat explanations to the maintainer. `AGENTS.md`,
`docs/CONTRIBUTING-DOCS.md` rule 9 and `docs/implementation-guide.md` are already updated;
the review verdict token moved from `Revisão:` to `Review:`.

Legacy Portuguese comments are translated **when the file is touched**, never as a separate
sweep: they are not a release blocker, and new code is written in English from today.

## 2. Translation waves

| Wave | Scope | Size |
|---|---|---|
| 1 | policy files | done |
| 2 | `README.md`, `AGENTS.md`, `docs/INDEX.md`, `docs/adr/` | ~40 files |
| 3 | remaining `docs/` (operations, guides) | ~21 files / 1886 lines |
| 4 | UI strings and error messages in `src/`, including the terms text | ~1000 strings, snapshot churn |

Waves 1–4 gate alpha.5. One PR per area; a UI translation is not mixed with a behaviour
change.

## 3. README

Professional entry point, in English: what the harness is, what it does that others do not
(cost, quota and audit trail governance), install, first run, commands, configuration,
profiles, declared limitations, security model, license. Installation in under five minutes.

## 4. GitHub hygiene — seven files, seven decisions

| File | Question |
|---|---|
| `.github/branch-protection.json` | applied configuration or dead record? If nothing applies it, it becomes prose in `docs/ci.md` |
| `.github/workflows/ci.yml` | no `bun audit`, no run on tag |
| `.github/workflows/packed-smoke.yml` | overlaps `ci.yml`? If so, runner cost without new coverage |
| `.github/workflows/bench.yml` | what triggers it and what does it cost |
| `.github/ISSUE_TEMPLATE/tarefa.md` | points at the historical `docs/roadmap.md` phases F0–F7 |
| `.github/pull_request_template.md` | does it cover RED, double review and size |
| `.github/dependabot.yml` | covers the 3 runtime and 4 dev dependencies |

## 5. Documents that die in this phase

`docs/tui-layout.md` describes the header, footer and `thinking… step n/max` that the TUIX
removes: it is rewritten in the TUIX PR, not here. `docs/roadmap.md` and
`docs/roadmap-complementar.md` are history (F0–F7) and gain a line at the top saying so, so
they stop being read as the current plan. `docs/INDEX.md` covers every file, including this
roadmap and the specs.

## 6. Acceptance

- [ ] A new contributor can install and run the harness from the README in under five minutes.
- [ ] No document asserts behaviour the code does not have.
- [ ] `docs/INDEX.md` lists every document in `docs/`.
- [ ] CI runs on tag and includes `bun audit`.
- [ ] UI strings, error messages and the terms text are in English.
- [ ] Every new code comment is in English.

## 7. Out of scope

Legacy comment sweep, i18n at runtime, a contributor handbook beyond the existing workflow
docs, marketing material.
