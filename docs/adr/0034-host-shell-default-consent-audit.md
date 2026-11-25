# ADR-0034: host shell by default, with per-command approval, consent and hashed audit

- Status: accepted; date 2026-11-23; issue #599
- Supersedes ADR-0031; related: D-11, I-03, I-11, I-19, ADR-0001, ADR-0027, ADR-0033

## Context

ADR-0031 made `"auto"` mean "Docker when available, host otherwise", but Docker is absent
on most machines and CI, so the shell was unusable or machine-dependent. #599 makes the
host the default and only active path (`off` disables it); Docker stays behind the alias.

## Decision

- `shell.mode` accepts only `host` and `off`; absent means `host`. No new key selects
  Docker, and `shell.mode` contradicting the legacy alias is a config error.
- Legacy `tools.run_command.sandbox` keeps its schema-1 meaning: `false` = `off`,
  `true`/`"docker"` = Docker required (refuses `sandbox_required_for_shell` without a
  Docker binary, never falling back to the host), `"auto"`/absent = `host`. This amends
  the Shell row of ADR-0033.
- Ordered prefix rules, last match wins, evaluated before the permission matrix. An
  explicit `deny` cannot be lifted by a mode or by a saved approval.
- The in-house scanner (`src/tools/shell-policy.ts`, ADR-0001) splits a compound
  command and every subcommand is evaluated; the prompt names the triggering part and an
  unparsable command is refused before execution.
- `once` approves one call; `always` writes a prefix rule in `shell.approvals` in the
  project layer (a configured `deny` still wins) only on the host; on Docker it is a
  session-wide grant, not call-scoped, and on the disabled transport it degrades to
  `once`; `reject` revokes session grants and denies the current call. `external_directory`
  outranks a rule `allow`. A `!cmd` of a runner created with `run_command` in
  `agent.tools` re-reads the config per run: a failed read denies (`config_unreadable`)
  and a removed `run_command` disables it; a runner created disabled never re-reads.
- `bypass` still needs `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`: every host command,
  including the human `!cmd` channel, is refused without it.
- Shell-risk consent is captured once at the interactive gate, next to the terms, and
  stored in `$ASTRO_HOME/state.json` with version and date. A decline turns the shell
  off for the session and writes nothing, so the next interactive start asks again;
  without a terminal the run proceeds (as with #479) and the gate stays the control.
- Every shell decision appends `host_shell.decision` with `commandHash`, `effect`,
  `origin` (`rule`/`approval`/`external_directory`/`unparsable`/`consent`/`mode`/`config`)
  and `transport`; a `!cmd` record adds `tool`, `stage` (`gate`), `permissionMode` and,
  on a `config_unreadable` deny, `code`, while the executor's execution record adds
  `tool`, `stage`, `permissionMode` and the selected `shell`. `tests.result` carries the
  same hash instead of the argv; the raw command and output never enter audit or ledger.
- The hash is 16 hex of an unsalted SHA-256 (no pepper in alpha.5): it correlates one
  command, but a short command is recoverable by enumeration (D-11).

## Consequences

- `astro run` works without Docker and behaves the same on every machine.
- The host loses Docker's `--network none`, read-only rootfs, `:ro` masks, `HOME=/tmp`
  and git neutralization; the command sees the user's filesystem, network and processes.
  What compensates: per-command approval with no session grant, the whole command in the
  prompt, hard-block at dispatch in every mode, sanitized env, redaction before
  truncation, hashed audit, the extra `bypass` confirmation. I-11 stays: the host is the
  default, confinement and hard-blocks remain active, and Docker keeps its own tests.

## Alternatives discarded

- Docker as default (unusable without a daemon) or a key that selects Docker (two
  sources of truth); auto-approve in `bypass`; persisting the raw command (D-11/I-03).
