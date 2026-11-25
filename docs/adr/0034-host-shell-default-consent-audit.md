# ADR-0034: host shell by default, with per-command approval, consent and hashed audit

- Status: accepted; date 2026-11-23; issue #599
- Supersedes ADR-0031; related: D-11, I-03, I-11, I-19, ADR-0001, ADR-0027, ADR-0033

## Context

ADR-0031 kept Docker as the preferred transport and made `"auto"` mean "Docker when
available, host otherwise". Docker is absent on most machines and on CI, so the shell
was either unusable or behaved differently per machine. #599 makes the host the default
and only active path, with `off` disabling it; the Docker code stays in
`src/tools/run-command.ts` behind the legacy alias.

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
  project layer (a configured `deny` still wins) only on the host, never on Docker
  or the disabled transport (elsewhere `always` degrades to `once`);
  `reject` revokes the session grants and denies the current call — no pending queue.
  `external_directory` outranks a rule `allow`. A `!cmd` re-reads the config per run:
  a failed read denies (`config_unreadable`) and a removed `run_command` disables it.
- `bypass` still needs `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`: every host command,
  including the human `!cmd` channel, is refused without it.
- Shell-risk consent is captured once at the interactive gate, next to the terms, and
  stored in `$ASTRO_HOME/state.json` with version and date. A decline turns the shell
  off for the session and writes nothing, so the next interactive start asks again;
  without a terminal the run proceeds (as with #479) and the gate stays the control.
- Every shell decision appends `host_shell.decision` with `commandHash`, `effect`,
  `origin` (`rule`/`approval`/`external_directory`/`unparsable`/`consent`/`mode`/`config`),
  `stage` (`gate`/`execution`), `tool`, `transport`, `permissionMode` and, on a
  `config_unreadable` deny, `code`; an execution
  `allow` carries the selected `shell`, and `tests.result` carries the same hash instead
  of the argv. The raw command and the output never enter audit or ledger (D-11, I-03).
- The hash is 16 hex of an unsalted SHA-256 (no pepper in alpha.5): it correlates one
  command, but a short command is recoverable by enumeration (D-11).

## Consequences

- `astro run` works without Docker and a command behaves the same on every machine.
- The host loses what Docker provided: no `--network none`, no read-only rootfs, no
  `:ro` masks of `.git`/hard-blocked paths, no `HOME=/tmp`, no git neutralization; the
  command sees the user's filesystem, network and processes. What compensates:
  per-command approval with no session grant, the whole command in the prompt,
  hard-block at dispatch in every mode, sanitized env, redaction before truncation,
  hashed audit, the extra `bypass` confirmation. I-11 stays: the host is the default,
  confinement and hard-blocks remain active, and the Docker path keeps its own tests.

## Alternatives discarded

- Docker as default (unusable without a daemon) or a key that selects Docker (two
  sources of truth); auto-approve in `bypass`; persisting the raw command (D-11/I-03).
