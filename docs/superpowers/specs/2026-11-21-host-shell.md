# S2 — Host shell

> Objective: run agent shell commands on the host with ordered rules, fail-closed parsing, approval and audit.

- Status: draft (alpha.5, phase P0.5)
- Date: 2026-11-21
- ADR: 0034 (supersedes ADR-0031; planned for this phase, not yet written)
- Depends on: S1 (aliases, profiles)
- Owner files: `src/tools/run-command.ts`, `src/tools/host-shell.ts`,
  `docs/security-threat-matrix.md`

## 1. Goal

Agent shell commands run on the host with the user's authority, protected by ordered rules, a
fail-closed scanner, explicit approval and audit. Docker is not the default and no new key
selects it: `shell.mode` offers only `host` and `off`, while a legacy `sandbox` that names
Docker keeps that requirement (§2).

## 2. Config

```jsonc
"shell": {
  "mode": "host",                       // "off" disables the tool
  "rules": [                            // order matters: the last match wins
    { "match": "git status *", "effect": "allow" },
    { "match": "git diff *",  "effect": "allow" },
    { "match": "*",           "effect": "ask" }
  ],
  "externalDirectory": "ask"
}
```

`mode` accepts only `"host"` and `"off"` in alpha.5; absent means `"host"`. No new key can
select Docker, and the Docker path stays in `src/tools/run-command.ts`, with its own tests
still running, so it does not rot and coverage does not drop.

A legacy `tools.run_command.sandbox` keeps its schema-1 meaning for `false` and
`true`/`"docker"`; `"auto"` and absent follow the alpha.5 change below. The alias never
lowers a security setting below what the file asked (ADR-0033, ADR-0028 "Guardas de
segurança"):

| Legacy value | Effective behavior |
|---|---|
| `false` | `shell.mode: "off"`; `run_command` refuses |
| `true` / `"docker"` | Docker required; without a Docker binary the tool refuses with `sandbox_required_for_shell` instead of falling back to the host |
| `"auto"` or absent | host with per-command approval (the alpha.5 default) |

`"auto"` or absent moving from "Docker when available" to "host" is the deliberate alpha.5
change, not an alias side effect: ADR-0034 supersedes ADR-0031 and **amends the Shell row of
ADR-0033** (`"auto"` and absent now mean host; `true`/`"docker"` still require Docker), I-11
is rewritten in `docs/invariants.md`, and the load prints one line stating that the shell now
runs on the host with per-command approval. A value that contradicts an explicit `shell.mode`
is a config error, not a silent winner.

## 3. Rules

Rules are prefix patterns over the command line, evaluated **before** the permission matrix.
An explicit `deny` beats an `allow` granted by the mode. The harness protects, it does not
forbid: the default is `ask`, and nothing is denied by heuristic alone.

Unchanged invariants, not up for user decision: hard-block of critical paths (`.git`, `.env`,
`.astro`, key material) and secret redaction before any output (I-03, I-11). They stop the
harness from leaking or corrupting state, not the user from running a command.

## 4. Scanner

A compound command (`;`, `&&`, `||`, `|`, subshell, `cd`, redirection) is split and **every**
subcommand is evaluated. A command the scanner cannot analyze — broken syntax, dynamic
expansion — is **refused**, never executed. The scanner is an in-house tokenizer: no new
runtime dependency (ADR-0001).

## 5. Approval

| Choice | Effect |
|---|---|
| `once` | approves this invocation only |
| `always` | writes the prefix rule in the **project** layer; a configured `deny` is never overridden by a saved approval |
| `reject` | cancels every pending approval in the session |

`external_directory` triggers its own decision when the working directory or inferred target
leaves the project. `bypass` asks nothing, so it warns: entering requires explicit consent,
a persistent on-screen warning stays visible while active, and the switch is recorded in the
audit log. The `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1` environment gate stays (ADR-0031,
"Decisão"): in `bypass`, **every** host command — a model tool call or the human `!cmd`
channel — is refused with `host_shell_confirmation_required` without that variable. No
config layer replaces the gate.

## 6. Risk consent

Captured once during setup, alongside the terms: the shell runs on the user's machine with
the user's authority, model-requested commands go through approval, and the allowlist is not
a guarantee. Stored in `state.json` with version and date, like the terms acceptance.

## 7. Profiles

`default` ships a short, safe allowlist (`git status|diff|log`, `ls`, `cat`, `rg`, `pwd`,
project test runners) and asks for everything else, including dangerous commands. `control`
edits the list, may add explicit `deny` rules and may choose `externalDirectory: "deny"`.

## 8. Tests and security docs

`run_tests` stops requiring Docker and uses the same `shell.mode` and approval path as
`run_command`. `docs/security-threat-matrix.md` is rewritten **in the same PR** (lines 22 and
36 currently describe `auto`/ADR-0031 as the live control) and ADR-0034 opens by stating it
supersedes ADR-0031.

## 9. Acceptance

- [ ] `astro run` executes shell commands with no Docker binary present.
- [ ] A compound command with one subcommand requiring a decision asks for the whole command
      and names the part that triggered it.
- [ ] An unparsable command is refused with instructions on how to allow it.
- [ ] `always` writes the prefix rule in the project and the second invocation does not ask.
- [ ] A command outside the allowlist is asked, even when it looks dangerous.
- [ ] `sandbox: true` or `"docker"` without a Docker binary refuses with
      `sandbox_required_for_shell`; it never runs on the host.
- [ ] `bypass` requires consent, shows a persistent warning and records the switch; without
      `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1` every host command, including `!cmd`, is refused.
- [ ] Every decision is audited with `commandHash`, effect and origin (rule/approval/mode);
      raw command and output never enter audit or ledger (D-11, I-03).
- [ ] The full suite passes on a machine without Docker, and the Docker path keeps its own
      tests green.

## 10. Out of scope

Reactivating or deleting the Docker path, network isolation, VM sandboxing, RPM/TPM limiting.
