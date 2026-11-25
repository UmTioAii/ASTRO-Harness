# ASTRO

ASTRO is a local, terminal-first harness for AI coding agents, built around one question: after the agent acts, can you say what it did, what it cost and who allowed it?

Every request becomes a session that plans, reads, writes and runs code inside a declared scope. Model calls are metered in an append-only ledger, tool calls pass an allowlist, a permission gate and path confinement, and every decision lands in a sanitized audit log. It runs on your machine, against the providers you choose, with no hosted service, no account and no telemetry by default.

Status: alpha; interfaces can still change. The phase plan is in [`docs/alpha.5-roadmap.md`](docs/alpha.5-roadmap.md).

## What it governs

| Control | What you get |
|---|---|
| Per-agent scope | Every agent has its own allowlist and model. Subagents spawned at runtime only choose inside the configured pool, and the choice is recorded in the ledger. |
| Profiles | `default` keeps counters out of the way; `control` exposes limits, budget, quota and cost detail. Promotion is explicit and reversible. |
| Spend | Tokens and cost per call in `.astro/ledger.jsonl`, an optional budget with warning, ceiling and hard cut, and token quotas enforced in Control. |
| Approvals | Four answers — `once`, `always`, `reject`, `deny` — for tools and shell commands. Fail-closed: anything unrecognized denies. |
| Audit | Append-only `.astro/audit.jsonl` with sanitized events; a shell decision records a command hash, never the raw command. |
| Host shell | `run_command` runs on the host with per-command approval by default. `shell.mode: "off"` disables it; Docker stays opt-in for untrusted repositories. |
| Reproducible runs | `replay`, `resume` and `continue` from the ledger and checkpoints, plus durable, digest-checked handoffs between agents. |
| Multi-provider | OpenAI-compatible providers, Codex OAuth, a declared model pool and deterministic routing. |
| Small surface | The harness code has zero runtime dependencies; the package ships a pinned Bun runtime and loads Ink/React only for the TUI (ADR-0001). |

## Install and first run (under five minutes)

Requirements: Node.js 18 or newer. The pinned Bun runtime ships with the package, so a global Bun install is not required.

```bash
npm install -g @umtioai/astro-harness@alpha
astro
```

In a terminal, the first `astro` walks three steps, in this order:

1. **Terms.** Five lines, accepted once per version with an empty answer; the acceptance is stored in `$ASTRO_HOME/state.json`. Any other answer, EOF included, declines and exits without writing.
2. **Profile.** `default` (recommended) or `control`. Default hides counters and advanced knobs; Control exposes limits, budget, quota and detailed cost.
3. **Provider.** Pick a provider, paste the key and choose a model. The key goes to the local vault at `~/.astro/vault.json` (DPAPI on Windows, file mode `0600` elsewhere) and the configuration stores only `vault:<credentialId>`; the key never reaches the project, the ledger or the audit log.

The wizard asks once per layer (global and project) and never overwrites an existing configuration file. Without a terminal it asks nothing and writes nothing: `astro setup --yes` accepts the profile defaults (it cannot choose a provider it does not have), and `astro setup` reruns the wizard later.

Then ask for something in TUIX, or run one task and exit:

```bash
astro run "explain the retry path in src/api.ts"
```

- `astro --help` and `astro help` print the command reference; `astro --version` prints the version.
- `astro chat` is the line-based session for terminals that cannot host the full-screen interface.
- `ASTRO_BUN_PATH=/path/to/bun astro` selects another Bun binary, which is required with `--omit=optional`, `--ignore-scripts`, or a Bun that only exists on `PATH`.

## Start a provider without the wizard

A complete environment set (key plus model) becomes an ephemeral provider named after it, used only by that invocation and never written to disk:

```bash
export NVIDIA_API_KEY="..."
export NVIDIA_MODEL="meta/llama-3.3-70b-instruct"
export NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"   # optional, this is the default
astro
```

`OPENAI_*`, `NVIDIA_*` and `OPENROUTER_*` are the supported sets. `ASTRO_PROVIDER` selects one by name; without it, exactly one complete set is used and two or more are a typed ambiguity error. A partial set never selects anything, and one provider's variables never select another. Declared configuration wins over the environment unless `ASTRO_PROVIDER` names a complete set. An `http://` base URL requires `ASTRO_ALLOW_INSECURE_BASE_URL=1` (development only).

In `astro.config.json`, `credentialRef` is either the name of an environment variable or `vault:<credentialId>` for a secret already in the vault:

| Provider kind | Credential |
|---|---|
| `openai-compat` | `credentialRef` naming an environment variable or `vault:<id>`; optional for local servers such as Ollama and LM Studio |
| `codex-oauth` | `~/.codex/auth.json` (or the `credentialsPath` you declare) |

## Configuration

ASTRO reads `astro.config.json` from the directory where you run it. A global layer at `$ASTRO_HOME/config.json` may exist; project values win, and `--no-global-config` ignores the global layer for that invocation. Flags such as `--permission-mode` and `--provider` win over both. The schema target is `2.2.0`; `astro config migrate` is the only writer that upgrades a file.

```json
{
  "version": "2.2.0",
  "preset": "default",
  "providers": {
    "nvidia": {
      "kind": "openai-compat",
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "credentialRef": "NVIDIA_API_KEY"
    }
  },
  "models": [
    { "provider": "nvidia", "id": "meta/llama-3.3-70b-instruct", "tags": ["writing-code", "tools"], "context": 131072 }
  ],
  "agent": { "model": "nvidia/meta/llama-3.3-70b-instruct" }
}
```

Everything else has a safe default:

| Field | Default | Meaning |
|---|---|---|
| `preset` | `default` | `default` hides counters and advanced knobs; `control` exposes them. `simple` normalizes to `default`. |
| `run.maxTurns` | `500` | Turns per run: one user request through its final answer. |
| `run.maxRoundsPerTurn` | `500` | Rounds inside a turn: one provider call plus the tools it requests. |
| `agent.maxSteps` | round alias | Readable alias kept from schema 1; an explicit `run.maxRoundsPerTurn` wins. |
| `agent.tools` | `read_file`, `write_file`, `edit`, `grep`, `list_dir`, `run_command` | The allowlist. Omitting it does not widen access, and `agents.<name>.tools` inherits the main agent's list. |
| `paths.ledger` / `paths.audit` | `.astro/ledger.jsonl` / `.astro/audit.jsonl` | Where the append-only records live, relative to the working directory. |
| `permissions.mode` | `ask` | Whether a tool call asks, is allowed, or is denied before running. |
| `shell.mode` | `host` | `host` runs shell commands on the host with per-command approval; `off` disables the tool. |

**Turns and rounds answer different questions.** A turn is policy and appears in Control; a round is a loop valve that fires only when one turn does not converge. `unlimited` removes only that ceiling, never budget, approval or security controls. A schema 1.x file that declares `run.maxTurns` is refused until `/config run.maxTurns` opts into the new meaning; nothing is reinterpreted silently (ADR-0033).

Budget, quota and loop guards are optional and independent:

```json
{
  "budget": { "scope": "day", "limitUsd": 5, "warnAt": 0.8, "onExceed": "ask", "hardCeilingUsd": 10 },
  "quota": { "default": { "dailyTokens": 2000000, "monthlyCostUsd": 20 } },
  "run": { "checkpointAt": 0.8, "noProgressSegments": 3, "judge": "off" }
}
```

- `budget.scope` is `day`, `month`, `project` or `use-as-you-go`; `limitUsd: null` records cost without blocking. `onExceed` is `ask` or `stop`, and `hardCeilingUsd` is a physical cut.
- `quota` is validated in both profiles and enforced only in Control; Default warns on load and ignores it (#617).
- `run` holds the loop guards: `checkpointAt` writes a checkpoint once at that fraction of the limit, `noProgressSegments` pauses when consecutive segments change nothing, and `judge` is `off`, `on` or `auto`.

Agents declared by you keep the model they declare. A full example with three providers is in [`astro.config.example.json`](astro.config.example.json); the provider guide is in [`docs/providers.md`](docs/providers.md).

Tool output is bounded: `outputLimit` defaults to `{ "maxTokens": 8000, "shareOfWindow": 0.05 }`, so a result is capped at `min(maxTokens, shareOfWindow × context)`. Oversized output goes to `.astro/outputs/<run>/` and the model receives the head, the tail and a source reference. Sessions compact before the window fills, keeping the recent tail and turning older history into a redacted `CompactionArtifactV1`.

## Approvals

`permissions.mode` decides whether a call asks. It never decides whether the fixed floor applies.

| Mode | Behavior |
|---|---|
| `ask` (default) | Common reads are allowed; critical reads, edits, critical writes, deletes and shell calls ask. |
| `allow-edits` | Edits run without asking; critical reads, critical writes, deletes and shell calls still ask. |
| `bypass` | Everything runs without asking, except what the hard block refuses. Entering requires `/mode bypass confirm` (and `ASTRO_HOST_SHELL_CONFIRM_BYPASS=1` for the shell), is audited, and stays visible in the interface. Switching provider or credential still asks in every mode. |

When a call asks, the prompt offers four answers:

| Answer | Effect |
|---|---|
| `s` (once) | Approve this call once. |
| `a` (always) | Approve from now on: a session grant, or a prefix rule saved in `shell.approvals` in the project layer, even when the action asks per call. |
| `r` (reject) | Deny this call and revoke the pending session grants. |
| `n` (deny) | Deny this call. |

Anything else denies: an empty answer, EOF or an unrecognized key is a denial, not an approval. `S` is the legacy synonym for `always`, limited to the current call when the action asks per call. A configured shell `deny` still wins over an `always` grant.

The fixed floor is enforced in every mode, including `bypass`: `.astro/` and configured `protectedPaths` cannot be written, critical paths (`.env*`, secrets, tokens, keys, the vault) are blocked or gated, file paths stay inside the working directory, secrets are redacted before any log or prompt, and the child environment is stripped of secret names. `shell.mode: "off"` turns the shell tool off; the legacy `tools.run_command.sandbox: true`/`"docker"` still requires Docker and never falls back to the host (ADR-0034). In a non-interactive context, `ask` records `permission.pending` and the run stops at a safe point.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `<credentialRef>` (for example `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`) | For OpenAI-compatible providers | Provider API key, named by the configuration. |
| `OPENAI_*` / `NVIDIA_*` / `OPENROUTER_*` (`_API_KEY` + `_MODEL`, optional `_BASE_URL`) | For the ephemeral env provider | One complete set defines a provider named after it; nothing is persisted. |
| `ASTRO_PROVIDER` | No | Selects the environment set (or a configured provider) by name; unknown is a typed error. |
| `ASTRO_ALLOW_INSECURE_BASE_URL` | No | `1` confirms an `http://` base URL from the environment (development only). |
| `ASTRO_PERMISSION_MODE` | No | Permission mode for the invocation; the flag wins over the environment and the configuration. |
| `ASTRO_HOST_SHELL_CONFIRM_BYPASS` | No | `1` is required for `run_command` under `bypass`, including the `!cmd` channel. |
| `ASTRO_HOME` | No | State directory; default `~/.astro`. |
| `ASTRO_NO_GLOBAL_CONFIG` | No | Ignore the global configuration layer. |
| `ASTRO_BUN_PATH` | No | Bun binary to use instead of the bundled one. |
| `ASTRO_ARTIFACT_ROOT` | No | Root of the image artifact store. |
| `ASTRO_CONFIG_REGISTRY` | No | Registry (`owner/repo`) used by `config push` and `config pull`. |
| `ASTRO_DOCKER_IMAGE` | No | Image for the legacy Docker shell path (`sandbox: true`/`"docker"`). |
| `ASTRO_PLUGIN_ALLOWLIST` | No | Remote plugin packages allowed to load. |
| `ASTRO_ALLOW_PRIVATE_URLS` | No | Opt in to private destinations for outgoing URLs. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Enables OpenTelemetry tracing. |
| `GH_TOKEN` / `GITHUB_TOKEN` | For `config push` / `config pull` | Registry token. |

## Commands

All commands run as `astro <command>`. From a clone, `bun src/cli.ts <command>` is equivalent.

| Command | Description |
|---|---|
| `astro` | Open TUIX; without a TTY, print the command reference. |
| `setup [--yes]` | Create the missing configuration layer, per layer, with the first-run wizard. |
| `run "<prompt>"` | Run a task end to end and print the answer and a summary. |
| `chat` | Line-based interactive session, including for non-TTY stdin. |
| `replay <run-id> --task "<prompt>"` | Re-run a task and compare it with the original record. |
| `resume <run-id> --task "<prompt>"` | Resume an interrupted run from its recorded agent. |
| `continue <run-id> [--task ...]` | Start a new run from a saved checkpoint, optionally with another agent. |
| `eval` | Run the golden dataset in mock mode as a regression gate. |
| `bench` | Report latency, tokens per second and cost per model. |
| `serve` | Expose `/metrics` in Prometheus format. |
| `health` | Validate configuration, credentials and provider connectivity. |
| `doctor [--json] [--fix] [--online]` | Local diagnostics: versions, dependencies, dist, config, credentials by name, skills, MCP and permissions. Details: [`docs/doctor.md`](docs/doctor.md). |
| `providers <health\|list\|test\|vault-import>` | Inspect providers, test credentials and import secrets into the vault. |
| `pool <list\|health>` | Inspect the model pool and its health. |
| `agents list`, `models list` | List declared agents and models. |
| `locks [release <run>]` | Inspect and release the per-account run locks. |
| `cost --by-agent` | Cost per agent and profile, read from the ledger. |
| `handoff show <handoff_id>` | Inspect a durable handoff and its compaction audit. |
| `config <push\|pull> <org/project>` | Share configuration through a registry. |
| `config migrate [--apply]` | Upgrade the configuration document to the current schema. |
| `skills <list\|show\|validate\|install\|remove\|verify>` | Manage skills. |
| `mcp <list\|test <server> <tool>>` | Inspect and probe MCP servers. |
| `--help`, `help`, `--version` | Command reference and version. |

## How a run works

1. The configuration is resolved: code defaults, then the global layer, then the project, then flags for this invocation. Every layer can only narrow the previous one.
2. Each turn sends the conversation to the model and runs the requested tools in order through the allowlist, the permission gate and path confinement. A round is one provider call plus its tools; `run.maxTurns` and `run.maxRoundsPerTurn` bound the two.
3. Every call appends to the ledger (agent, provider, model, tokens, cost) and to the audit log (sanitized decisions and events). The prompt itself is not persisted; only its hash is.
4. The run ends at the final answer, at a declared limit, at a denied approval or at the budget ceiling. Every stop is a safe point: `resume` replays from the ledger and `continue` restarts from a checkpoint.
5. Handoffs between agents are durable artifacts, idempotent by `handoff_id`, verified on receipt and digest-checked.

## Security

These guarantees are enforced in code and covered by tests:

| Guarantee | Invariant or decision |
|---|---|
| Secrets live only in the local vault or in a named environment variable, and are redacted from logs, audit, ledger, errors and prompts. | I-03 |
| Tools outside the agent allowlist never run, and denials are audited. | I-01 |
| File paths stay inside the working directory; symlinks and junctions are resolved. | I-11 |
| `.astro/` and `protectedPaths` cannot be written by tools, in any permission mode. | I-11 |
| The shell runs on the host with per-command approval, a hard block at dispatch and hashed audit; Docker is opt-in. | I-03, I-11, I-19 |
| Prompts are never persisted; `run.started` stores only a task hash. | D-11 |
| In the Control profile, quotas and budgets block before spending, and the hard ceiling is physical. | I-17, #617 |
| Provider, model or credential changes require approval, including in `bypass`. | I-08 |

Report security issues privately through the repository's security advisories, not as public issues.

## Development

```bash
bun install --frozen-lockfile
bun run dev         # open TUIX from source, no build
bun test            # full suite
bun run typecheck   # tsc --noEmit
bun run build       # build dist/cli.js and dist/launcher.js
bun run smoke       # build, then validate the Node launcher without Bun on PATH
bun run doctor      # local diagnostics, no network
bun link            # after a build, point the global astro at this checkout
```

Before a pull request, `bun test` and `bun run typecheck` must pass. CI adds coverage, `bun audit`, the eval gate and a secrets scan. Changes are test-driven: the failing test (RED) lands before the fix (GREEN) and is described in the pull request. The flow is in [`docs/workflow.md`](docs/workflow.md).

## Documentation

[`docs/INDEX.md`](docs/INDEX.md) is the map: one row per subject, so you open only what the task needs. Start with:

| File | Contents |
|---|---|
| [`docs/implementation-guide.md`](docs/implementation-guide.md) | Implementing an issue end to end: TDD, branch, PR, double review, merge. |
| [`docs/invariants.md`](docs/invariants.md) | Invariants I-01 onwards, mapped to code. |
| [`docs/decisions.md`](docs/decisions.md) | Decisions D-01 onwards. |
| [`docs/adr/`](docs/adr/) | Architecture decision records. |
| [`docs/config-parity.md`](docs/config-parity.md) | Configuration ownership, parity and precedence. |
| [`docs/alpha.5-roadmap.md`](docs/alpha.5-roadmap.md) | Current roadmap: phases, issues, ADRs and open decisions. |
| [`docs/roadmap.md`](docs/roadmap.md) | History: completed phases F0–F7. |

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first; in short: one issue per change, one branch per item, a test-first pull request with two independent reviews, and a squash merge. All repository artifacts are written in English.

## License

MIT. See [`LICENSE`](LICENSE).
