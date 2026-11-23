# ASTRO

ASTRO is a local, terminal-first harness for AI coding agents. Every request becomes a session that plans, reads, writes and runs code inside a declared scope, with an append-only ledger and cost metered on every model call.

It runs on your machine, against the providers you choose, and it is built for the questions that show up after the first demo: which model ran this step, what it cost, who approved the write, and whether the run can be reproduced.

## Who it is for

- Developers who run coding agents against real repositories and need to know what changed and what it cost.
- Teams that want a fixed model per role, a shared provider pool, and a reviewable record of every decision.
- People evaluating models or prompts, because `eval` and `bench` run the same harness.
- Anyone who needs a denial to be an auditable event instead of a silent failure.

ASTRO runs locally. There is no hosted service, no account and no telemetry by default.

## Install

Requirements: Node.js 18 or newer. The pinned Bun runtime ships with the npm package, so a global Bun install is not required.

```bash
npm install -g @umtioai/astro-harness@alpha
astro
```

`astro` without arguments opens TUIX, the interactive interface, when stdin and stdout are terminals. Without a TTY it prints the command reference and exits 0, which keeps CI and pipes safe.

- `astro --help` and `astro help` print the command reference.
- `astro --version` prints the installed version.
- `astro chat` starts the line-based session for terminals that cannot host the full-screen interface.

To use a specific Bun binary: `ASTRO_BUN_PATH=/path/to/bun astro`. With `--omit=optional`, `--ignore-scripts`, or a Bun that only exists on `PATH`, set `ASTRO_BUN_PATH` or make `bun` available on `PATH`.

## Start a provider

There are two ways to give ASTRO a model. Both end in the same place: the configuration names a provider and a model, and the credential is referenced by name.

**1. Provider setup inside TUIX (zero config).** With no configuration and no provider in the environment, `astro` opens the provider screen. Pick a provider, paste the key and choose a model. The key goes to the local vault at `~/.astro/vault.json` — protected by DPAPI on Windows and by file mode `0600` elsewhere — and the configuration stores only `vault:<credentialId>`. The key is never written to the project, the ledger or the audit log.

**2. Environment variables.** Each provider reads its own variable set, `OPENAI_*`, `NVIDIA_*` or `OPENROUTER_*` (key, model and optional base URL):

```bash
export ASTRO_PROVIDER="nvidia"            # only selector; optional when one set is complete
export NVIDIA_API_KEY="..."
export NVIDIA_MODEL="meta/llama-3.3-70b-instruct"
export NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"   # optional, this is the default
astro
```

A complete set (key plus model) becomes an ephemeral provider named after the provider (`openai`, `nvidia`, `openrouter`), used only by that invocation and never written to disk. The env sets are a fallback: they are ignored when the declared layers or the store already resolve provider and model, unless `ASTRO_PROVIDER` names a complete set. `ASTRO_PROVIDER` selects the set; an unknown name is a typed error. Without it, exactly one complete set is used and two or more are a typed ambiguity error. A partial set never selects anything, and one provider's variables never select another. If a layer already declares the same provider id, the declaration wins and the env models are not injected; an explicit selector for that id fails with `provider_env_collision`. `ASTRO_MODEL` and `ASTRO_BASE_URL` were removed. An `http://` base URL requires explicit confirmation with `ASTRO_ALLOW_INSECURE_BASE_URL=1` (development only).

For any provider declared in `astro.config.json`, `credentialRef` is either the name of an environment variable (for example `NVIDIA_API_KEY`) or `vault:<credentialId>` for a secret already in the local vault.

| Provider kind | Credential |
|---|---|
| `openai-compat` | `credentialRef` naming an environment variable or `vault:<id>`; optional for local servers such as Ollama and LM Studio |
| `codex-oauth` | `~/.codex/auth.json` (or the `credentialsPath` you declare) |

## The interactive session (TUIX)

TUIX is the full-screen interface: a conversation panel, an input line and a live status footer. The header shows the version, the active provider/model and provider health. The footer always shows the permission mode — highlighted when it is `bypass` — together with the session usage and budget.

Slash commands cover the session without leaving the interface:

| Command | Purpose |
|---|---|
| `/help` | List every command. |
| `/model`, `/providers`, `/provider` | Inspect or switch the model and manage provider profiles. |
| `/mode [mode]` | Show or change the permission mode; entering `bypass` requires `/mode bypass confirm` and is audited. |
| `/config` | Open the configuration screen: `agent.maxSteps`, costs per model, permission mode, budget and trusted folders. |
| `/session`, `/details`, `/usage` | Session summary, provider details, turns, tokens, cost and budget. |
| `/sessions`, `/resume`, `/save`, `/export` | Saved sessions, restore, persist and export the conversation. |
| `/compact`, `/summarize` | Compact the history into a summary. |
| `/attach`, `/paste`, `/detach` | Attachments from files, the clipboard or pending items. |
| `/init` | Create `AGENTS.md` in the current directory. |
| `/log`, `/theme`, `/new`, `/clear`, `/exit` | Session log, theme, reset and exit. |

`@` starts path completion for files and directories. `astro chat` runs the same harness through a line-based REPL for terminals that cannot host the full-screen interface, including non-TTY stdin.

## Configuration

ASTRO reads `astro.config.json` from the directory where you run it. A global layer at `$ASTRO_HOME/config.json` may exist; project values win, and `--no-global-config` ignores the global layer for that invocation. Flags such as `--permission-mode` and `--provider` win over both.

```json
{
  "providers": {
    "nvidia": {
      "kind": "openai-compat",
      "baseUrl": "https://integrate.api.nvidia.com/v1",
      "credentialRef": "NVIDIA_API_KEY"
    }
  },
  "models": [
    {
      "provider": "nvidia",
      "id": "meta/llama-3.3-70b-instruct",
      "tags": ["writing-code", "tools"],
      "context": 131072
    }
  ],
  "agent": {
    "model": "nvidia/meta/llama-3.3-70b-instruct"
  }
}
```

Everything else has a safe default:

| Field | Default | Meaning |
|---|---|---|
| `agent.maxSteps` | `500` | The single work limit, counted in steps per task and per agent. |
| `agent.tools` | `read_file`, `write_file`, `edit`, `grep`, `list_dir`, `run_command` | The allowlist. Omitting it does not widen access: `agent.tools` inherits exactly the zero-config set, and `agents.<name>.tools` inherits the main agent's list. |
| `paths.ledger` / `paths.audit` | `.astro/ledger.jsonl` / `.astro/audit.jsonl` | Where the append-only records live, relative to the working directory. |
| `permissions.mode` | `ask` | Whether a tool call asks, is allowed, or is denied before running. |
| `preset` | `control` | `simple` caps work at 500 steps and rejects higher values; `control` exposes the knobs. |

**The run limit is counted in steps, not turns.** A step is one model call plus the tool calls it requests. A turn is an interaction unit used by the interface and by `/usage`; it is not a limit. A run stops at the final answer or when `agent.maxSteps` is exhausted, and the error names the exact field to change (`agent.maxSteps` or `agents.<name>.maxSteps`). `run.maxTurns` was removed: a configuration that still declares it fails to load with a message pointing to `agent.maxSteps`. Long sessions are bounded by `budget`, which is measured in money, not in messages.

Budget and loop guards are optional and independent:

```json
{
  "permissions": { "mode": "ask" },
  "budget": { "scope": "day", "limitUsd": 5, "warnAt": 0.8, "onExceed": "ask", "hardCeilingUsd": 10 },
  "run": { "checkpointAt": 0.8, "noProgressSegments": 3, "judge": "off" }
}
```

- `budget.scope` is `day`, `month`, `project` or `use-as-you-go`; `limitUsd: null` records cost without blocking. `onExceed` is `ask` or `stop`, and `hardCeilingUsd` is a physical cut.
- `run` holds the loop guards: `checkpointAt` writes a checkpoint once at that fraction of the step limit, `noProgressSegments` pauses when consecutive segments change nothing, and `judge` is `off`, `on` or `auto`.

Agents declared by you keep the model they declare. Subagents created by the model at runtime can only choose inside the configured pool, and the choice is recorded in the ledger. A full example with three providers is in [`astro.config.example.json`](astro.config.example.json); the provider guide is in [`docs/providers.md`](docs/providers.md).

Tool output is bounded. `outputLimit` defaults to `{ "maxTokens": 8000, "shareOfWindow": 0.05 }`, so a tool result is capped at `min(maxTokens, shareOfWindow × context)`. Oversized output goes to `.astro/outputs/<run>/` and the model receives the head, the tail and a source reference.

Sessions compact before the context window fills. The trigger is `window − reserve`, where `reserve` is `max(15% of the window, 16.000)` or the declared `compaction.buffer`; the recent tail is preserved and the older history becomes a redacted `CompactionArtifactV1`.

## Approvals

`permissions.mode` decides whether a call asks. It never decides whether the fixed floor applies.

| Mode | Behavior |
|---|---|
| `ask` (default) | Common reads are allowed; critical reads, edits, critical writes, deletes and shell calls ask. |
| `allow-edits` | Edits run without asking; critical reads, critical writes, deletes and shell calls still ask. |
| `bypass` | Everything runs without asking. Entering `bypass` requires confirmation (`/mode bypass confirm`), is audited as `mode.changed`, and the mode stays visible in the interface. Switching provider or credential still asks in every mode. |

When a call asks, the prompt has exactly three answers:

| Answer | Effect |
|---|---|
| `s` | Approve this call once. |
| `n` | Deny this call. |
| `S` | Approve for the rest of the session. The grant lives in memory and is never persisted. |

Anything else denies. Fail-closed is the rule: an empty answer, EOF or an unrecognized key is a denial, not an approval.

The fixed floor is enforced in every mode, including `bypass`: `.astro/` and configured `protectedPaths` cannot be written, critical paths (`.env*`, secrets, tokens, keys, the vault) are blocked or gated, file paths stay inside the working directory, secrets are redacted before any log or prompt, and `run_command` runs on the **host** with per-command approval by default (#599, ADR-0034 planned). `tools.run_command.sandbox: true`/`"docker"` forces Docker (recommended for untrusted repositories) and refuses without the daemon; what the host loses is in ADR-0031. In a non-interactive context, `ask` denies with `permission.pending` and the run stops at a safe point instead of proceeding.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `<credentialRef>` (for example `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`) | For OpenAI-compatible providers | Provider API key, named by the configuration. |
| `OPENAI_*` / `NVIDIA_*` / `OPENROUTER_*` (`_API_KEY` + `_MODEL`, optional `_BASE_URL`) | For the ephemeral env provider | One complete set defines a provider named after it (`openai`, `nvidia`, `openrouter`); nothing is persisted. |
| `ASTRO_PROVIDER` | No | Selects the environment set (or a configured provider) by name; unknown is a typed error. |
| `ASTRO_ALLOW_INSECURE_BASE_URL` | No | `1` confirms an `http://` base URL from the environment (development only). |
| `ASTRO_PERMISSION_MODE` | No | Permission mode for the invocation; the flag wins over the environment and the configuration. |
| `ASTRO_HOME` | No | State directory; default `~/.astro`. |
| `ASTRO_NO_GLOBAL_CONFIG` | No | Ignore the global configuration layer. |
| `ASTRO_BUN_PATH` | No | Bun binary to use instead of the bundled one. |
| `ASTRO_ARTIFACT_ROOT` | No | Root of the image artifact store. |
| `ASTRO_CONFIG_REGISTRY` | No | Registry (`owner/repo`) used by `config push` and `config pull`. |
| `ASTRO_DOCKER_IMAGE` | No | Sandbox image used by `run_command`. |
| `ASTRO_PLUGIN_ALLOWLIST` | No | Remote plugin packages allowed to load. |
| `ASTRO_ALLOW_PRIVATE_URLS` | No | Opt in to private destinations for outgoing URLs. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Enables OpenTelemetry tracing. |
| `GH_TOKEN` / `GITHUB_TOKEN` | For `config push` / `config pull` | Registry token. |

## Commands

All commands run as `astro <command>`. From a clone, `bun src/cli.ts <command>` is equivalent.

| Command | Description |
|---|---|
| `astro` | Open TUIX; without a TTY, print the command reference. |
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
| `cost --by-agent` | Cost per agent and profile, read from the ledger. |
| `handoff show <handoff_id>` | Inspect a durable handoff and its compaction audit. |
| `config <push\|pull> <org/project>` | Share configuration through a registry. |
| `skills <list\|show\|validate\|install\|remove\|verify>` | Manage skills. |
| `mcp <list\|test <server> <tool>>` | Inspect and probe MCP servers. |
| `--help`, `help`, `--version` | Command reference and version. |

## How a run works

1. The configuration is resolved: code defaults, then the global layer, then the project, then flags for this invocation. Every layer can only narrow the previous one.
2. The task becomes a step loop. Each step sends the conversation to the model, records the completion, and executes the requested tools in order through the allowlist, the permission gate and path confinement.
3. Each step appends to the ledger (agent, provider, model, tokens, cost) and to the audit log (sanitized decisions and events). The prompt itself is not persisted; only its hash is.
4. The run ends at the final answer, at `agent.maxSteps`, at a denied approval or at the budget ceiling. Every stop is a safe point: `resume` replays from the ledger and `continue` restarts from a checkpoint.
5. Handoffs between agents are durable artifacts, idempotent by `handoff_id`, verified on receipt and digest-checked.

## Security

These guarantees are enforced in code and covered by tests:

| Guarantee | Invariant |
|---|---|
| Secrets live only in the local vault or in a named environment variable, and are redacted from logs, audit, ledger, errors and prompts. | I-03 |
| Tools outside the agent allowlist never run, and denials are audited. | I-01 |
| File paths stay inside the working directory; symlinks and junctions are resolved. | I-11 |
| `.astro/` and `protectedPaths` cannot be written by tools, in any permission mode. | I-11 |
| `run_command` runs on the host with per-command approval by default (#599, ADR-0034 planned); `sandbox: true`/`"docker"` forces Docker; the child environment is stripped of secret names. | I-03, I-11 |
| Prompts are never persisted; `run.started` stores only a task hash. | I-04 |
| In the Control profile, quotas and budgets block before spending, and the hard ceiling is physical; the Default profile ignores declared token quotas (#617). | I-17 |
| Provider, model or credential changes require approval, including in `bypass`. | I-08 |

Report security issues privately through the repository's security advisories, not as public issues.

## Status

ASTRO is in **alpha**; interfaces may still change before a stable release. The foundation, multi-agent core, tools, evaluation and hardening phases (F0–F7) are done. The current gaps are tracked in [`docs/roadmap.md`](docs/roadmap.md) and [`docs/roadmap-complementar.md`](docs/roadmap-complementar.md).

The CLI, the interface messages and the documents under `docs/` are written in Portuguese (pt-BR); this README is in English. Code identifiers and configuration keys are in English.

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

Before opening a pull request, all four gates must pass: `bun test`, `bun run typecheck`, `bun run build` and `bun run smoke`. Changes are test-driven: the failing test (RED) lands before the fix (GREEN) and is described in the pull request.

## Documentation

| File | Contents |
|---|---|
| [`docs/workflow.md`](docs/workflow.md) | Branch, commit, pull request and merge flow. |
| [`docs/review-checklist.md`](docs/review-checklist.md) | Pull request review checklist. |
| [`docs/invariants.md`](docs/invariants.md) | Invariants I-01 to I-22, mapped to code. |
| [`docs/decisions.md`](docs/decisions.md) | Decisions D-01 onwards. |
| [`docs/config-parity.md`](docs/config-parity.md) | Configuration ownership, parity and precedence. |
| [`docs/adr/`](docs/adr/) | Architecture decision records. |
| [`docs/providers.md`](docs/providers.md) | Providers, credentials and SDKs. |
| [`docs/doctor.md`](docs/doctor.md) | `astro doctor` checks and the `doctor/v1` format. |
| [`docs/skills.md`](docs/skills.md) | Creating, installing and invoking skills. |
| [`docs/mcp.md`](docs/mcp.md) | MCP servers, transports and trust. |
| [`docs/eval.md`](docs/eval.md) | Golden dataset, bench metrics and CI scheduling. |
| [`docs/release.md`](docs/release.md) | Release gate, tag, publish and rollback. |
| [`docs/roadmap.md`](docs/roadmap.md), [`docs/roadmap-complementar.md`](docs/roadmap-complementar.md) | Completed phases and planned layers. |

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/workflow.md`](docs/workflow.md) first. In short: one issue per change, one branch per item, a test-first pull request with independent review, and a squash merge.

## License

MIT. See [`LICENSE`](LICENSE).
