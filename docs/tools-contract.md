# Tool output contract

One contract for every tool result: a declared ceiling, an explicit truncation marker, redaction before any cut, and a closed failure taxonomy (`#603`).

| Covers | Does not cover |
|---|---|
| Ceiling, truncation marker, redaction order and failure codes of a tool result | What each tool does (per-tool docs and `src/tools/`), the turn token cap (CMP-10), web backends (`docs/web-tools.md`) |

Normative spec: `docs/superpowers/specs/2026-11-21-tools-contract.md` (S6).

| Concern | Rule | Where |
|---|---|---|
| Ceiling | A tool that can emit unbounded text declares `manifest.output.maxTokens`; the result never exceeds it | `src/tools/types.ts` (`ToolOutputCeiling`) |
| Truncation | Every cut states what was removed and how to ask for the rest | `src/tools/contract.ts` (`truncationReport`) |
| Redaction | `redactSecrets` runs at the source, before any cut, so a cut inside a secret cannot leave a prefix (I-03) | `src/sanitize-external.ts` |
| Failure | `failure` is one of `denied`, `failed`, `timeout`, `invalid`; `code` keeps the policy reason (`path_hard_blocked`, `invalid_manifest`, ...) | `src/tools/types.ts` (`ToolFailure`) |
| Trust | File, web and tool output is data, never an instruction | — |

## Ceiling

`manifest.output` uses the same `~4 chars/token` estimator as `CMP-10`. The effective ceiling is
`min(declared maxTokens, ctx.outputLimitTokens)`, so the session cap only lowers it (`outputCeilingChars`).
`contentBudgetChars` reserves `MARKER_RESERVE_CHARS` so the marker and JSON envelope stay inside the ceiling.
A tool without `manifest.output` keeps its previous behaviour; declaring a ceiling is the migration step tracked by `#603`.

## Truncation marker

Plain text appends the marker line; JSON envelopes carry `truncated: true` plus a `notice` with the same text, so
`JSON.parse` never breaks. `ToolResult.truncation` mirrors `{ removed, total, unit, hint }` so no consumer parses prose.

```
[output truncated: 120 of 500 entries omitted; list a subdirectory or lower depth to see the rest]
```

## Failure taxonomy

| Code | Meaning | Producer |
|---|---|---|
| `denied` | Policy refused: allowlist, ceiling, permission, path hard-block, approval refusal | `src/tools/executor.ts` |
| `invalid` | Malformed input: bad JSON arguments, rejected `ToolError` | tool or executor |
| `timeout` | Manifest timeout or expired approval wait | executor |
| `failed` | Execution error or cancellation | tool or executor |

The executor reclassifies any error result without a valid code as `failed`, so a plugin cannot leak a fifth code.
Tests: `tests/tools-contract.test.ts` covers the primitives; each migrated tool adds direct tests for happy path,
ceiling and marker, redaction before truncation, and every taxonomy code it returns — executor coverage does not count.
