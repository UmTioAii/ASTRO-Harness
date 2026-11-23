# ADR-0034: host shell by default, with per-command approval, consent and hashed audit

- Status: accepted
- Date: 2026-11-23; issue #599
- Supersedes ADR-0031; related: D-11, I-03, I-11, I-19, ADR-0001, ADR-0027, ADR-0033

## Context

ADR-0031 kept Docker as the preferred transport and made `"auto"` mean "Docker when
available, host otherwise". Docker is absent on most machines and on CI, so the shell
was either unusable or silently behaved differently per machine. #599 makes the host
the default and only active path, with `off` disabling it; the Docker code stays in
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
  command and every subcommand is evaluated; the prompt names the triggering part, and
  a command the scanner cannot parse is refused before execution.
- `once` approves one call; `always` writes a prefix rule in `shell.approvals` in the
  project layer (a configured `deny` still wins); `reject` cancels pending approvals.
  `external_directory` outranks a rule `allow` when the cwd or an inferred target leaves
  the project.
- `bypass` still needs `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1`: every host command,
  including the human `!cmd` channel, is refused without it.
- Shell-risk consent is captured once at the interactive gate, next to the terms, and
  stored in `$ASTRO_HOME/state.json` with version and date. A decline turns the shell
  off for the session and writes nothing, so the next interactive start asks again;
  without a terminal the run proceeds (as with #479) and the gate stays the control.
- Every shell decision appends `host_shell.decision` with `commandHash` (16 hex of
  SHA-256), `effect`, `origin` (`rule`/`approval`/`external_directory`/`unparsable`/
  `consent`/`mode`), `stage` (`gate`/`execution`), tool, transport and permission
  mode. The raw command and the output never enter audit or ledger (D-11, I-03); the
  hash correlates, it is not reversible proof of content.

## Consequences

- `astro run` works without Docker and a command behaves the same on every machine.
- The host loses what Docker provided: no `--network none`, no read-only rootfs, no
  `:ro` masks of `.git`/hard-blocked paths, no `HOME=/tmp`, no git neutralization. The
  command sees the user's filesystem, network and running processes. Per-command
  approval with no session grant, the whole command in the prompt, hard-block at
  dispatch in every mode, sanitized env, redaction before truncation, hashed audit and
  the extra `bypass` confirmation are what compensates. I-11 stays: the host is the
  default, confinement and hard-blocks remain active, and the Docker path keeps its
  own tests so it does not rot.

## Alternatives discarded

- Docker as default (unusable without a daemon) or a key that selects Docker (two
  sources of truth), auto-approve in `bypass` (review skipped), and persisting the raw
  command for correlation (violates D-11/I-03; a hash correlates).
