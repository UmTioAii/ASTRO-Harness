/**
 * Spawn de subagente em runtime (C4a, ADR-0008): registra o filho, adquire a
 * conta exclusiva (A4) e devolve a identidade para o handoff do orchestrator.
 * Execução é serial no v1: o filho só roda quando recebe o handoff.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Auditor } from "./audit";
import { AccountLockedError, acquireAgentLock, releaseAgentLock } from "./agent-lock";
import { activeByAccount, grantConcurrency, spawnConcurrencyCap, type ConcurrencyGrant } from "./concurrency";
import { redactSecrets } from "./sanitize-external";
import type { AstroConfig, BudgetConfig } from "./core/config";
import { providerAccountRefFor } from "./core/config";
import type { Ledger } from "./ledger";
import {
  CandidateSetChangedError,
  listModelCandidates,
  ModelChoiceError,
  resolveModelChoice,
  type CandidateDeps,
  type ModelCandidate,
  type ModelChoice,
} from "./model-choice";
import type { QuotaLimit } from "./quota";
import type { AgentEntry, Registry } from "./core/registry";
import { mostRestrictive, type AgentPermission } from "./permissions";
import { ROLE_TAGS } from "./tags";
import type { Tool, ToolContext, ToolResult } from "./tools/types";

/** Teto de spawns por run (A2). */
export const DEFAULT_MAX_SPAWNS_PER_RUN = 8;

/**
 * Teto efetivo de spawns por run (#552): `spawn.maxActive` declarado, clampado
 * no teto default; sem config, o default.
 */
export function spawnLimitFromConfig(config: AstroConfig): number {
  return Math.min(DEFAULT_MAX_SPAWNS_PER_RUN, config.spawn?.maxActive ?? DEFAULT_MAX_SPAWNS_PER_RUN);
}
const MAX_AGENTS_MD = 16_000;

/** Limite de spawns do run excedido (golden §11.3). */
export class SpawnLimitError extends Error {
  readonly code = "spawn_limit_exceeded";
  constructor(limit: number) {
    super(`limite de ${limit} spawns por run excedido`);
    this.name = "SpawnLimitError";
  }
}

/** Teto de agentes ativos do run (ADR-0037: concorrência por provider). */
export class SpawnConcurrencyError extends Error {
  readonly code = "spawn_limit_exceeded";
  constructor(limit: number, provider?: string) {
    super(
      provider === undefined
        ? `limite de concorrência de ${limit} execuções por provider atingido`
        : `limite de concorrência de ${limit} execuções no provider "${provider}" atingido`,
    );
    this.name = "SpawnConcurrencyError";
  }
}

/** Refusal from the shared commit path; `code` is the stable tool contract. */
export class SpawnRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SpawnRefusedError";
    this.code = code;
  }
}

/** Subagente nascido em runtime, fixado no spawn (ADR-0007/0008). */
export interface SpawnedAgent {
  agent_id: string;
  parent_agent_id: string;
  candidate: ModelCandidate;
  tools: string[];
  /** Round ceiling for the child's single turn (≤ the parent). */
  maxRounds: number;
  /** Turns accepted by the child; a spawn runs one task, so it is always 1. */
  maxTurns: number;
  /** Task entregue ao filho; `AGENTS.md` vem do system prompt base (A9/CMP-8). */
  instructions: string;
  reason: string;
  createdAt: number;
  /** Declared by the named agent (#602); absent = inherits the caller's restriction. */
  permission?: AgentPermission;
}

/**
 * Effective permission of a spawned child (#602, D-24): the declared mould and
 * the caller can only narrow the executor's base, never widen it.
 */
export function spawnedPermission(
  spawned: Pick<SpawnedAgent, "permission">,
  caller: AgentPermission | undefined,
  base: AgentPermission | undefined,
): AgentPermission {
  return mostRestrictive(spawned.permission ?? "full", mostRestrictive(caller ?? "full", base ?? "full"));
}

/** Estado de spawns do run (v1 serial). */
export class SpawnRegistry {
  readonly #agents = new Map<string, SpawnedAgent>();
  readonly #limit: number;
  #count = 0;

  constructor(opts: { limit?: number } = {}) {
    this.#limit = opts.limit ?? DEFAULT_MAX_SPAWNS_PER_RUN;
  }

  get size(): number {
    return this.#agents.size;
  }

  get limit(): number {
    return this.#limit;
  }

  get(agentId: string): SpawnedAgent | undefined {
    return this.#agents.get(agentId);
  }

  list(): SpawnedAgent[] {
    return [...this.#agents.values()];
  }

  /** Próximo id livre, sem colidir com agents declarados. */
  nextId(reserved: ReadonlySet<string>): string {
    for (;;) {
      this.#count++;
      const id = `sub-${this.#count}`;
      if (!reserved.has(id) && !this.#agents.has(id)) return id;
    }
  }

  add(agent: SpawnedAgent): void {
    // Fail-closed no próprio registro (#552): o teto vale mesmo se um chamador
    // novo esquecer de checar `size >= limit` antes.
    if (this.#agents.size >= this.#limit) throw new SpawnLimitError(this.#limit);
    this.#agents.set(agent.agent_id, agent);
  }

  /** Remove um spawn que falhou depois da aquisição do lock. */
  remove(agentId: string): void {
    this.#agents.delete(agentId);
  }

  /** Converte o spawn para o contrato de agent do loop multi-agent. */
  toAgentEntry(agent: SpawnedAgent, baseSystemPrompt?: string, permission?: AgentPermission): AgentEntry {
    const systemPrompt = [baseSystemPrompt, agent.instructions].filter((part) => part !== undefined && part.length > 0).join("\n\n");
    return {
      model: agent.candidate.model,
      ...(agent.candidate.profile === undefined ? {} : { profile: agent.candidate.profile }),
      maxSteps: agent.maxRounds,
      tools: agent.tools,
      ...(permission === undefined ? {} : { permission }),
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
    };
  }
}

/** Dependências do tool (o run injeta config/ledger/registry/spawns). */
export interface SpawnToolDeps {
  config: AstroConfig;
  registry: Registry;
  ledger: Ledger;
  audit: Auditor;
  cwd: string;
  spawns: SpawnRegistry;
  /** false no caminho single/chat: a tool falha fechada com `spawn_unavailable`. */
  enabled: boolean;
  quotaLimits?: Record<string, QuotaLimit>;
  budget?: BudgetConfig | (() => BudgetConfig);
}

function candidateDeps(deps: SpawnToolDeps): CandidateDeps {
  const budget = typeof deps.budget === "function" ? deps.budget() : deps.budget;
  return {
    config: deps.config,
    registry: deps.registry,
    ledger: deps.ledger,
    activeAccountCounts: activeByAccount(deps.ledger),
    maxPerAccount: spawnConcurrencyCap(deps.config).cap,
    ...(deps.quotaLimits === undefined ? {} : { quotaLimits: deps.quotaLimits }),
    ...(budget === undefined ? {} : { budget }),
  };
}

export function readAgentsMd(cwd: string): string {
  try {
    const text = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    return text.length > MAX_AGENTS_MD ? text.slice(0, MAX_AGENTS_MD) : text;
  } catch {
    return "";
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function toolError(error: unknown): ToolResult {
  if (error instanceof CandidateSetChangedError) {
    return {
      output: JSON.stringify({
        error: error.code,
        message: error.message,
        snapshot_id: error.snapshot.snapshot_id,
        expires_at: error.snapshot.expires_at,
        candidates: error.snapshot.candidates,
      }),
      isError: true,
    };
  }
  if (error instanceof ModelChoiceError || error instanceof AccountLockedError || error instanceof SpawnLimitError || error instanceof SpawnConcurrencyError || error instanceof SpawnRefusedError) {
    const candidates = error instanceof ModelChoiceError ? error.candidates : undefined;
    return {
      output: JSON.stringify({
        error: error.code,
        message: error.message,
        ...(candidates === undefined ? {} : { candidates }),
      }),
      isError: true,
    };
  }
  throw error;
}

/** Everything the shared commit needs once the model choice is resolved. */
export interface SpawnCommitRequest {
  need: string;
  choice: ModelChoice;
  tools: readonly string[];
  maxRounds: number;
  instructions: string;
  /** Caller rationale; the model-choice reason is prepended to it. */
  reason: string;
  requestedConcurrency?: number;
  snapshotId?: string;
  /** Mould permission (#602); absent = the caller's restriction applies. */
  permission?: AgentPermission;
  /** `agents.<name>.when` that requested this spawn; absent = model-requested. */
  rule?: string;
}

export interface SpawnCommitResult {
  agentId: string;
  model: string;
  profile?: string;
  grant: ConcurrencyGrant;
}

/**
 * Depth, run cap and scope, shared by both doors (#602). Throws before any
 * model work, so a refused request never consumes a candidate snapshot.
 */
function assertSpawnAllowed(
  deps: SpawnToolDeps,
  ctx: ToolContext,
  tools: readonly string[],
  maxRounds: number,
): void {
  // v1 is depth one: a spawned child never spawns a grandchild.
  if (deps.spawns.get(ctx.agent) !== undefined) {
    throw new SpawnRefusedError("invalid_request", "subagente não pode spawnar outro subagente em v1");
  }
  if (deps.spawns.size >= deps.spawns.limit) throw new SpawnLimitError(deps.spawns.limit);
  const parentAllow = ctx.allow ?? [];
  const outside = tools.filter((tool) => !parentAllow.includes(tool));
  if (outside.length > 0) {
    throw new SpawnRefusedError("invalid_request", `tools fora do escopo do pai: ${outside.join(", ")}`);
  }
  const parentMax = ctx.maxSteps ?? deps.config.agent.maxSteps;
  if (maxRounds > parentMax) {
    throw new SpawnRefusedError("invalid_request", `maxRounds ${maxRounds} excede o teto do pai (${parentMax})`);
  }
}

/**
 * The single engine for child creation (#602, ADR-0036 §2): a model-requested
 * spawn and a declarative rule both land here. Depth, run cap, account cap,
 * scope, lock, ledger and `agent.spawn` audit are therefore shared; callers
 * only supply the already-resolved model choice.
 */
export function commitSpawn(deps: SpawnToolDeps, ctx: ToolContext, req: SpawnCommitRequest): SpawnCommitResult {
  assertSpawnAllowed(deps, ctx, req.tools, req.maxRounds);
  const tools = [...req.tools];
  if (tools.length > 0) {
    const entry = deps.registry.get(req.choice.candidate.model);
    if (!req.choice.candidate.tags.includes("tools") || entry?.capabilities?.tools !== true) {
      throw new SpawnRefusedError("invalid_model_choice", `modelo "${req.choice.candidate.model}" não declara suporte a tools`);
    }
  }

  const slash = req.choice.candidate.model.indexOf("/");
  const provider = req.choice.candidate.model.slice(0, slash);
  const modelId = req.choice.candidate.model.slice(slash + 1);
  const providerConfig = deps.config.providers[provider];
  if (providerConfig === undefined) {
    throw new SpawnRefusedError("invalid_model_choice", `provider "${provider}" desconhecido`);
  }

  const cap = spawnConcurrencyCap(deps.config);
  const accountRef = providerAccountRefFor(provider, providerConfig);
  const rawCredential = (providerConfig as { credentialRef?: unknown }).credentialRef;
  const keyless = providerConfig.kind === "openai-compat" &&
    (typeof rawCredential !== "string" || rawCredential.length === 0);
  if ((activeByAccount(deps.ledger).get(accountRef) ?? 0) >= cap.cap) {
    throw new SpawnConcurrencyError(cap.cap, provider);
  }

  const grant = grantConcurrency(req.requestedConcurrency, cap);
  const agentId = deps.spawns.nextId(new Set(Object.keys(deps.config.agents ?? {})));
  const reason = [req.choice.reason, req.reason].filter((part) => part.length > 0).join(": ").slice(0, 200);

  acquireAgentLock(deps.ledger, deps.audit, {
    run: ctx.run,
    agent_id: agentId,
    session_id: ctx.run,
    provider,
    model: modelId,
    ...(keyless ? {} : { credentialRef: accountRef }),
    accountRef,
    ...(req.choice.candidate.profile === undefined ? {} : { profile: req.choice.candidate.profile }),
    parent_agent_id: ctx.agent,
    reason,
    need: req.need,
    ...(req.snapshotId === undefined ? {} : { snapshot_id: req.snapshotId }),
    maxConcurrent: cap.cap,
  });

  try {
    deps.spawns.add({
      agent_id: agentId,
      parent_agent_id: ctx.agent,
      candidate: req.choice.candidate,
      tools,
      maxRounds: req.maxRounds,
      maxTurns: 1,
      instructions: req.instructions,
      reason,
      createdAt: Date.now(),
      ...(req.permission === undefined ? {} : { permission: req.permission }),
    });
    deps.audit.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "agent.spawn",
      payload: {
        agent_id: agentId,
        parent_agent_id: ctx.agent,
        provider,
        model: req.choice.candidate.model,
        ...(req.choice.candidate.profile === undefined ? {} : { profile: req.choice.candidate.profile }),
        ...(req.snapshotId === undefined ? {} : { snapshot_id: req.snapshotId }),
        need: req.need,
        requested: grant.requested,
        granted: grant.granted,
        cap: grant.cap,
        // `source` names the door (tier or rule); `grant_source` keeps ADR-0037.
        source: req.rule === undefined ? grant.source : "rule",
        ...(req.rule === undefined ? {} : { rule: req.rule }),
        grant_source: grant.source,
        reason,
        grant_reason: grant.reason,
        truncated: grant.truncated,
        ...(grant.truncated ? { cut: grant.reason } : {}),
        limits: { rounds: req.maxRounds, turns: 1 },
      },
    });
  } catch (error) {
    deps.spawns.remove(agentId);
    try {
      releaseAgentLock(deps.ledger, deps.audit, { run: ctx.run, agent_id: agentId, reason: "spawn_failed" });
    } catch {
      // Preserve the original error; the orphan sweep covers the I/O failure.
    }
    throw error;
  }

  return {
    agentId,
    model: req.choice.candidate.model,
    ...(req.choice.candidate.profile === undefined ? {} : { profile: req.choice.candidate.profile }),
    grant,
  };
}

export interface DeclaredSpawnRequest {
  /** Named agent acting as the mould; it is also the rule name in the audit. */
  agent: string;
  /** The declared model; a rule never ranks candidates. */
  model: ModelCandidate;
  tools: readonly string[];
  maxRounds: number;
  /** The named agent's own prompt, never a harness expansion of the turn text. */
  instructions: string;
  /** The named agent's declared permission, carried into the child (D-24). */
  permission?: AgentPermission;
}

/**
 * Declarative door (#602): commits a rule-matched child through `commitSpawn`,
 * the same engine as `spawn_agent`. The scope is intersected with the parent
 * before the commit, so a declaration can never widen it, and `task` /
 * `spawn_agent` are removed so depth stays one.
 */
export function spawnDeclaredChild(
  deps: SpawnToolDeps,
  parent: { run: string; agent: string; allow: readonly string[]; maxSteps: number },
  request: DeclaredSpawnRequest,
): SpawnCommitResult {
  if (!deps.enabled) {
    throw new SpawnRefusedError("spawn_unavailable", "spawn_agent só está disponível em run multi-agent");
  }
  const allow = new Set(parent.allow);
  const tools = request.tools.filter((tool) => allow.has(tool) && tool !== "task" && tool !== "spawn_agent");
  return commitSpawn(
    deps,
    { cwd: deps.cwd, run: parent.run, agent: parent.agent, allow: [...allow], maxSteps: parent.maxSteps },
    {
      need: "declared",
      choice: { candidate: request.model, reason: `rule:${request.agent}` },
      tools,
      maxRounds: request.maxRounds,
      instructions: request.instructions,
      reason: "",
      ...(request.permission === undefined ? {} : { permission: request.permission }),
      rule: request.agent,
    },
  );
}

const SPAWN_PARAMETERS = {
  type: "object",
  properties: {
    need: { type: "string", description: "Papel do subagente (ROLE_TAGS)" },
    task: { type: "string", description: "Tarefa entregue ao subagente" },
    model: { type: "string", description: "Modelo do snapshot (provider/id); omitido = rank 1" },
    reason: { type: "string", maxLength: 200, description: "Justificativa da escolha" },
    tools: { type: "array", items: { type: "string" }, description: "Subconjunto das tools do pai" },
    maxRounds: { type: "integer", minimum: 1, description: "Teto de rodadas do subagente (≤ pai)" },
    maxTurns: { type: "integer", minimum: 1, description: "Turnos do subagente; um spawn executa uma tarefa, então aceita 1" },
    concurrency: { type: "integer", minimum: 1, description: "Execuções simultâneas pedidas para a conta; acima do limite é truncado e o resultado informa o corte" },
    maxSteps: { type: "integer", minimum: 1, description: "Removido: use maxRounds (rodadas) ou maxTurns (turnos)" },
    snapshot_id: { type: "string", description: "Snapshot de list_model_candidates" },
  },
  required: ["need", "task"],
  additionalProperties: false,
};

/** Tool `spawn_agent` (A1/A2/A3/A5/A10/A11). */
export function createSpawnAgentTool(deps: SpawnToolDeps): Tool {
  return {
    manifest: {
      name: "spawn_agent",
      description: "Cria um subagente com modelo da pool, escopo ⊆ pai e conta compartilhada até o limite; use handoff para executá-lo.",
      parameters: SPAWN_PARAMETERS,
      risk: "medium",
      permission: "spawn_agent",
      // Mesma classe que o main infere (sideEffects "none"): o spawn em si é orquestração;
      // o filho roda com ceiling próprio.
      class: "read_common",
      timeoutMs: 5000,
      retryable: false,
      idempotent: false,
      sideEffects: "none",
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      try {
        if (!deps.enabled) {
          return {
            output: JSON.stringify({
              error: "spawn_unavailable",
              message: "spawn_agent só está disponível em run multi-agent",
            }),
            isError: true,
          };
        }
        const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        if (typeof raw.need !== "string" || raw.need.trim().length === 0) {
          return { output: JSON.stringify({ error: "invalid_need", message: "campo 'need' é obrigatório" }), isError: true };
        }
        if (!ROLE_TAGS.some((role) => role === raw.need)) {
          return { output: JSON.stringify({ error: "invalid_need", message: `need "${raw.need}" não é um papel válido` }), isError: true };
        }
        if (typeof raw.task !== "string" || raw.task.trim().length === 0) {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'task' é obrigatório" }), isError: true };
        }
        if (raw.model !== undefined && typeof raw.model !== "string") {
          return { output: JSON.stringify({ error: "invalid_model_choice", message: "campo 'model' deve ser string" }), isError: true };
        }
        if (raw.reason !== undefined && typeof raw.reason !== "string") {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'reason' deve ser string" }), isError: true };
        }
        if (raw.snapshot_id !== undefined && typeof raw.snapshot_id !== "string") {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'snapshot_id' deve ser string" }), isError: true };
        }
        if (raw.tools !== undefined && !isStringArray(raw.tools)) {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'tools' deve ser lista de strings" }), isError: true };
        }
        if (raw.maxSteps !== undefined) {
          return {
            output: JSON.stringify({
              error: "invalid_request",
              message: "maxSteps was removed: use maxRounds for rounds per turn and maxTurns for turns",
            }),
            isError: true,
          };
        }
        const requestedMaxRounds = raw.maxRounds;
        if (requestedMaxRounds !== undefined && (typeof requestedMaxRounds !== "number" || !Number.isInteger(requestedMaxRounds) || requestedMaxRounds < 1)) {
          return { output: JSON.stringify({ error: "invalid_request", message: "campo 'maxRounds' deve ser inteiro >= 1" }), isError: true };
        }
        const requestedMaxTurns = raw.maxTurns;
        if (requestedMaxTurns !== undefined && requestedMaxTurns !== 1) {
          return {
            output: JSON.stringify({
              error: "invalid_request",
              message: "um spawn executa uma tarefa (one turn); 'maxTurns' aceita apenas 1",
            }),
            isError: true,
          };
        }
        const requestedConcurrency = raw.concurrency;
        if (requestedConcurrency !== undefined && (typeof requestedConcurrency !== "number" || !Number.isInteger(requestedConcurrency) || requestedConcurrency < 1)) {
          return { output: JSON.stringify({ error: "invalid_request", message: "field 'concurrency' must be an integer >= 1" }), isError: true };
        }

        const parentAllow = ctx.allow ?? [];
        const tools = raw.tools === undefined ? [...parentAllow] : raw.tools;
        const childMax = requestedMaxRounds ?? ctx.maxSteps ?? deps.config.agent.maxSteps;

        // Depth, run cap and scope fail before any model work; the shared commit
        // repeats them so no caller can bypass the engine.
        assertSpawnAllowed(deps, ctx, tools, childMax);

        // ADR-0037: the harness grants at most the per-account cap. A provider
        // whose account is at the cap is not a candidate; all full is a clear cut.
        const cap = spawnConcurrencyCap(deps.config);
        const activeAccounts = activeByAccount(deps.ledger);
        const open = Object.keys(deps.config.providers)
          .filter((provider) => {
            const config = deps.config.providers[provider];
            return config === undefined ||
              (activeAccounts.get(providerAccountRefFor(provider, config)) ?? 0) < cap.cap;
          });
        if (open.length === 0) throw new SpawnConcurrencyError(cap.cap);

        const cdeps = candidateDeps(deps);
        let snapshotId = typeof raw.snapshot_id === "string" ? raw.snapshot_id : undefined;
        let choice;
        if (snapshotId !== undefined) {
          choice = resolveModelChoice(snapshotId, raw.model, cdeps, raw.need);
        } else {
          const query = {
            need: raw.need,
            ...(tools.length > 0 ? { requires: ["tools"] } : {}),
          };
          snapshotId = listModelCandidates(query, cdeps).snapshot_id;
          choice = resolveModelChoice(snapshotId, raw.model, cdeps, raw.need);
        }

        const committed = commitSpawn(deps, ctx, {
          need: raw.need,
          choice,
          tools,
          maxRounds: childMax,
          // AGENTS.md já entra pelo system prompt base da sessão (CMP-8).
          instructions: raw.task,
          reason: typeof raw.reason === "string" ? raw.reason : "",
          ...(requestedConcurrency === undefined ? {} : { requestedConcurrency }),
          ...(snapshotId === undefined ? {} : { snapshotId }),
        });

        const grant = committed.grant;
        const notes: string[] = [];
        if (grant.truncated) notes.push(grant.reason);
        if (raw.maxTurns !== undefined && requestedMaxRounds === undefined) {
          notes.push("maxTurns now means turns; set maxRounds to cap rounds");
        }
        return {
          output: JSON.stringify({
            agent_id: committed.agentId,
            model: committed.model,
            ...(committed.profile === undefined ? {} : { profile: committed.profile }),
            status: "active",
            limits: { rounds: childMax, turns: 1 },
            concurrency: grant,
            ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
          }),
          isError: false,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  };
}
