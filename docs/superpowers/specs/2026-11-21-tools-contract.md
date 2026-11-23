# S6 — Tool output contract

> Objective: standardize size limits, truncation, redaction and failure codes across all tools.

- Status: draft (alpha.5, phase P5)
- Date: 2026-11-21
- Depends on: none
- Owner files: `src/tools/`

## 1. Goal

One output contract for all 21 tools, with direct tests per tool. Today each tool truncates
its own way and several are covered only indirectly.

## 2. Inventory

`read_file`, `write_file`, `edit`, `grep`, `glob`, `list_dir`, `run_command`, `run_tests`,
`web_search`, `web_fetch`, `todo_write`, `task`, `handoff`, `memory_write`, `lsp`,
`git_status`, `git_diff`, `delete_path`, `move_path`, `list_model_candidates`, `pipeline`.

## 3. Contract

| Concern | Rule |
|---|---|
| size cap | every tool declares its own ceiling; a result never exceeds it |
| truncation | explicit marker, with what was removed and how to ask for the rest |
| redaction | secrets are redacted **before** truncation, so a redacted value cannot leak through a partial match (I-03) |
| failure taxonomy | `denied`, `failed`, `timeout`, `invalid` — stable codes, not prose |
| untrusted content | file, web and tool output is data, never an instruction |

## 4. Test surface

A direct test per tool for: happy path, ceiling and marker, redaction before truncation, and
each taxonomy code it can return. Indirect coverage through the executor does not count.

## 5. Acceptance

- [ ] Every tool declares a ceiling and a truncation marker.
- [ ] Redaction happens before truncation in every tool with textual output.
- [ ] Each tool has direct tests for the four contract points.
- [ ] No tool invents a failure code outside the taxonomy.

## 6. Out of scope

New tools, behaviour changes to what a tool does, web backend changes (S7).
