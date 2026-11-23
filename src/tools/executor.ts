import { auditDurationMs, type Auditor } from "../audit";
import { callId } from "../call-id";
import { NoProgressError } from "../loop-guard";
import { limitToolOutput } from "../output-limit";
import { redactSecrets } from "../sanitize-external";
import {
  actionClassOf,
  approvalDetailOf,
  normalizeApprovalDetail,
  permissionDecision,
  permissionAllows,
  requiredPermission,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_PERMISSION_MODE,
  PATH_HARD_BLOCKED,
  PathHardBlockedError,
  PermissionGrants,
  PermissionPendingError,
  denyDisplayPath,
  requiresPerCallApproval,
  pathCandidatesOf,
  resolveArtifactRoot,
  resolveAstroHome,
  type ActionClass,
  type AgentPermission,
  type PermissionApproval,
  type PermissionDecision,
  type PermissionMode,
  type ToolPermissionRequest,
} from "../permissions";
import { AllowlistInvalidError, classifyPath, type PathClass } from "../path-class";
import { validateManifest } from "../sdk/tool";
import { join, relative } from "node:path";
import type { ToolCall, ToolDef } from "../providers/types";
import { failureCodeOf, isToolFailure } from "./contract";
import { type Tool, type ToolContext, type ToolFailure, type ToolLifecycleEvent, type ToolResult } from "./types";

const TIMEOUT = Symbol("timeout");
const ABORTED = Symbol("aborted");
/** Teto de um path no `tool.call` (#535): cabeçalho + cauda não; o path inteiro basta até aqui. */
const AUDIT_PATH_MAX_CHARS = 200;

/** AbortError padrão para quando o signal do run não traz `reason`. */
function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("cancelado", "AbortError");
}

/** Cancelamento da espera de aprovação: timeout do gate ou cancelamento do run (#526). */
export interface ApprovalWait {
  signal?: AbortSignal;
  /** Limite configurado em ms (`0` = sem limite); ausente quando desligado. */
  timeoutMs?: number;
  /** Marcado pelo gate quando a espera terminou por timeout, não por cancelamento. */
  timedOut?: boolean;
}

/** Aprovador humano de uma chamada de tool no modo `ask` (PERM-01); `"session"` grava grant na sessão (#266). */
export type ToolApprover = (
  request: ToolPermissionRequest,
  wait?: ApprovalWait,
) => PermissionApproval | Promise<PermissionApproval>;

/** Nome de diretório seguro para o run id (nunca escapa do cwd). */
function safeRunDir(run: string): string {
  const clean = run.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 64);
  return clean.length === 0 ? "run" : clean;
}

function failure(message: string, code: ToolFailure): ToolResult {
  return { output: message, isError: true, failure: code };
}

/**
 * Problema do manifesto no dispatch (#264): tool de plugin não passa pelo
 * typechecker e `class` ausente/desconhecida deixaria o gate sem decisão.
 */
function manifestProblem(manifest: unknown): string | undefined {
  try {
    validateManifest(manifest);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "manifesto inválido";
  }
}

/**
 * Anexo de diff para a UI de aprovação (#64): só a tool `edit`, com `path` e
 * `diff` string no input. O conteúdo passa por `redactSecrets` antes de sair
 * do executor (I-03) e o anexo nunca é auditado.
 */
function editDiffAnnex(call: ToolCall, input: unknown): { path: string; content: string } | undefined {
  if (call.name !== "edit") return undefined;
  if (typeof input !== "object" || input === null) return undefined;
  const raw: { path?: unknown; diff?: unknown } = input;
  if (typeof raw.path !== "string" || typeof raw.diff !== "string") return undefined;
  return { path: redactSecrets(raw.path), content: redactSecrets(raw.diff) };
}

/** Executa tools com allowlist, teto de escopo (ceiling), timeout e auditoria; erros voltam como resultado de tool. */
export class ToolExecutor {
  private readonly tools: readonly Tool[];
  private readonly byName: Map<string, Tool>;
  private readonly allowSet: Set<string>;
  private readonly ceilingSet: Set<string>;
  private readonly auditRef: Auditor;
  /** Modo do gate por chamada (PERM-01); default `ask`. */
  private readonly mode: PermissionMode;
  /** Aprovação humana injetada pela TUI/REPL/CLI; ausente = fail-closed (ask vira deny). */
  private readonly approveTool?: ToolApprover;
  /** Grants em memória da sessão (PERM-05); compartilhado com subagentes. */
  readonly permissionGrants: PermissionGrants;
  /** Perfil do agent (#58); a mais restritiva entre ele e a allowlist vence. */
  private readonly agentPermission: AgentPermission;
  /** Teto da espera por aprovação em ms (#526); `0` desliga. */
  private readonly approvalWaitTimeoutMs: number;

  constructor(opts: {
    tools: readonly Tool[];
    allow: string[];
    audit: Auditor;
    ceiling?: string[];
    permissionMode?: PermissionMode;
    approveTool?: ToolApprover;
    /** Teto da espera por aprovação em ms (#526); default 300000, `0` desliga. */
    approvalTimeoutMs?: number;
    /** Grants da sessão; subagente recebe os mesmos grants do executor pai. */
    grants?: PermissionGrants;
    /** Perfil de permissão do agent (#58); default `full` (compat). */
    permission?: AgentPermission;
  }) {
    this.tools = opts.tools;
    this.byName = new Map(opts.tools.map((tool) => [tool.manifest.name, tool]));
    this.allowSet = new Set(opts.allow);
    // Ceiling: teto de escopo para subagents (I-02). Default = allow (sem restrição extra).
    this.ceilingSet = new Set(opts.ceiling ?? opts.allow);
    this.auditRef = opts.audit;
    this.mode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.approveTool = opts.approveTool;
    this.permissionGrants = opts.grants ?? new PermissionGrants();
    this.agentPermission = opts.permission ?? "full";
    this.approvalWaitTimeoutMs = opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /** Perfil de permissão do agent (filho herda do seu próprio perfil, não do pai). */
  get permission(): AgentPermission {
    return this.agentPermission;
  }

  /** Teto da espera por aprovação em ms (subagente herda do executor pai). */
  get approvalTimeoutMs(): number {
    return this.approvalWaitTimeoutMs;
  }

  /** Modo de permissão corrente (subagente herda do executor pai). */
  get permissionMode(): PermissionMode {
    return this.mode;
  }

  /** Aprovador de tools (subagente herda do executor pai). */
  get toolApprover(): ToolApprover | undefined {
    return this.approveTool;
  }

  /** Todas as tools registradas (para multi-agent session). */
  get allTools(): readonly Tool[] {
    return this.tools;
  }

  /** Allowlist do executor (para teto de subagents). */
  get allow(): ReadonlySet<string> {
    return this.allowSet;
  }

  /** Teto de escopo (ceiling) do executor (I-02). */
  get ceiling(): ReadonlySet<string> {
    return this.ceilingSet;
  }

  /** Auditoria da sessão (para tools de composição logarem eventos próprios). */
  get audit(): Auditor {
    return this.auditRef;
  }

  /** Definições das tools permitidas, no formato exposto ao provider. */
  defs(): ToolDef[] {
    return this.tools
      .filter((tool) => this.allowSet.has(tool.manifest.name))
      .map((tool) => ({
        name: tool.manifest.name,
        description: tool.manifest.description,
        parameters: tool.manifest.parameters,
      }));
  }

  async run(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    // Tempo do ciclo completo da chamada; vai no tool.result como payload
    // padronizado (issue #61), não no tool.call, que marca o início.
    const startedAt = Date.now();
    // Argumento material no `tool.call` (#535): `delete`/`edit` registram O QUE
    // foi tocado, não só o nome da tool. Redigido e truncado; conteúdo nunca
    // entra (I-03). Demais classes mantêm o payload sem paths.
    const paths = this.callPaths(call);
    const pathPayload = paths.length === 0 ? {} : { paths };
    // Dedup por call_id determinístico (F-03), apenas para tools declaradas
    // idempotentes (F-10, I-12); as demais sempre executam de verdade.
    const { step, journal } = ctx;
    if (step !== undefined && journal !== undefined) {
      const id = callId(ctx.run, step, call);
      const tool = this.byName.get(call.name);
      const cached = tool?.manifest?.idempotent === true ? journal.lookup(id) : undefined;
      if (cached !== undefined) {
        // A deduped call emits no lifecycle pair; nothing executed.
        this.auditRef.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "tool.dedup",
          payload: { name: call.name, callId: id },
        });
        return cached;
      }
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.call",
        payload: { name: call.name, callId: id, ...pathPayload },
      });
      this.emitTool(ctx, { phase: "start", callId: call.id, name: call.name, arguments: call.arguments });
      const result = this.classify(await this.execute(ctx, call));
      journal.record(id, result);
      this.emitTool(ctx, { phase: "end", callId: call.id, isError: result.isError === true, durationMs: auditDurationMs(startedAt) });
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.result",
        payload: { name: call.name, isError: result.isError === true, callId: id, durationMs: auditDurationMs(startedAt) },
      });
      return result;
    }

    this.auditRef.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.call",
      payload: { name: call.name, ...pathPayload },
    });

    this.emitTool(ctx, { phase: "start", callId: call.id, name: call.name, arguments: call.arguments });
    const result = this.classify(await this.execute(ctx, call));
    this.emitTool(ctx, { phase: "end", callId: call.id, isError: result.isError === true, durationMs: auditDurationMs(startedAt) });


    this.auditRef.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.result",
      payload: { name: call.name, isError: result.isError === true, durationMs: auditDurationMs(startedAt) },
    });

    return result;
  }

  /** Live signal for the turn observer; sync or async observer errors never abort the tool (#600). */
  private emitTool(ctx: ToolContext, event: ToolLifecycleEvent): void {
    try {
      const out: unknown = ctx.onToolEvent?.(event);
      if (out !== null && typeof out === "object" && typeof (out as { then?: unknown }).then === "function") {
        void Promise.resolve(out).catch(() => {});
      }
    } catch {
      // The observer is a consumer, not an execution dependency.
    }
  }

  /** A result without a valid taxonomy code is `failed` (S6, #603), so a plugin cannot leak one. */
  private classify(result: ToolResult): ToolResult {
    if (result.isError !== true) return result;
    return isToolFailure(result.failure) ? result : { ...result, failure: "failed" };
  }

  private async execute(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    const tool = this.byName.get(call.name);
    if (tool === undefined) {
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason: "tool desconhecida" },
      });
      return failure(`tool desconhecida: "${call.name}"`, "denied");
    }
    if (!this.allowSet.has(call.name)) {
      const reason = `tool "${call.name}" não permitida para o agent "${ctx.agent}"`;
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason },
      });
      return failure(reason, "denied");
    }
    // Ceiling enforcement (I-02): tool no allow mas fora do teto do parent → negado
    if (!this.ceilingSet.has(call.name)) {
      const reason = `tool "${call.name}" fora do teto de escopo do agent "${ctx.agent}"`;
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason },
      });
      return failure(reason, "denied");
    }
    // Manifesto inválido falha fechado antes de qualquer decisão (#264): sem
    // `class` válida o gate não pode escolher entre allow/ask/deny e o
    // `requiredPermission` não pode tocar um manifesto ausente.
    const problem = manifestProblem(tool.manifest);
    if (problem !== undefined) {
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason: "invalid_manifest" },
      });
      return { ...failure(`tool "${call.name}" recusada: ${problem}`, "denied"), code: "invalid_manifest" };
    }
    // Perfil do agent (#58): a permissão mais restritiva entre I-01 e o perfil vence
    const required = requiredPermission(tool.manifest);
    if (!permissionAllows(this.agentPermission, required)) {
      const reason = `tool "${call.name}" exige permissão "${required}" (agent "${ctx.agent}" tem "${this.agentPermission}")`;
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tool.denied",
        payload: { name: call.name, reason, required, permission: this.agentPermission },
      });
      return failure(reason, "denied");
    }

    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      return failure(`argumentos ilegíveis para a tool "${call.name}": JSON inválido`, "invalid");
    }

    const blocked = await this.permissionGate(ctx, tool, call, input);
    if (blocked !== undefined) return blocked;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // Controller por call: timeout e cancelamento do run abortam a tool em voo
    // (run_command mata a árvore de processos), não só desistem de esperar.
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortError(ctx.signal?.reason));
    if (ctx.signal?.aborted === true) controller.abort(abortError(ctx.signal.reason));
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const aborted = new Promise<typeof ABORTED>((resolve) => {
      if (controller.signal.aborted) resolve(ABORTED);
      else controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
    });

    try {
      const timeout = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), tool.manifest.timeoutMs);
      });
      const outcome = await Promise.race([
        tool.execute(input, { ...ctx, signal: controller.signal, executor: this, permission: this.agentPermission }),
        timeout,
        aborted,
      ]);

      if (outcome === TIMEOUT) {
        controller.abort(new DOMException(`timeout de ${tool.manifest.timeoutMs}ms`, "AbortError"));
        return failure(
          `timeout: a tool "${call.name}" excedeu ${tool.manifest.timeoutMs}ms`,
          "timeout",
        );
      }
      if (outcome === ABORTED) {
        return failure(`cancelado: a tool "${call.name}" foi interrompida`, "failed");
      }
      return this.limitOutput(ctx, call, outcome);
    } catch (error) {
      // Pending do gate ou pausa por não-progresso sobe e para o run em ponto seguro (I-19), não vira tool error.
      if (error instanceof PermissionPendingError || error instanceof NoProgressError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro na tool "${call.name}": ${message}`, failureCodeOf(error));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Espera a resposta humana com teto (#526): o timeout do gate e o
   * `AbortSignal` do run encerram a espera, em vez de prender o run — e a conta
   * exclusiva que ele segura — para sempre. `0` desliga o teto; o
   * `PermissionPendingError` do aprovador sem TTY continua subindo (I-19).
   */
  private async awaitApproval(
    ctx: ToolContext,
    request: ToolPermissionRequest,
  ): Promise<PermissionApproval | undefined | typeof TIMEOUT | typeof ABORTED> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (ctx.signal?.aborted === true) controller.abort();
    else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Já cancelado: não abre prompt nenhum.
      if (controller.signal.aborted) return ABORTED;
      const wait: ApprovalWait = {
        signal: controller.signal,
        ...(this.approvalWaitTimeoutMs > 0 ? { timeoutMs: this.approvalWaitTimeoutMs } : {}),
      };
      const answer = Promise.resolve(this.approveTool?.(request, wait));
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });
      const timeout = new Promise<typeof TIMEOUT>((resolve) => {
        if (this.approvalWaitTimeoutMs <= 0) return;
        timer = setTimeout(() => resolve(TIMEOUT), this.approvalWaitTimeoutMs);
      });
      const outcome = await Promise.race([answer, timeout, aborted]);
      // Expirou: aborta o controller para a TUI/REPL descartar a pergunta pendente.
      // `timedOut` vai antes do abort para a superfície distinguir timeout de cancelamento.
      if (outcome === TIMEOUT) {
        wait.timedOut = true;
        controller.abort();
      }
      return outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Gate por chamada depois do allowlist e do ceiling (PERM-01, I-01). `deny`
   * bloqueia; `ask` consulta o aprovador injetado pela TUI/REPL/CLI.
   * **Fail-closed**: sem aprovador, `ask` vira `deny` — a chamada nunca segue
   * sem aprovação humana registrada. Aprovador que não pode perguntar (sem TTY,
   * CLI não interativa, #262) lança `PermissionPendingError`: o gate audita
   * `permission.pending` e relança, e o run para em ponto seguro (I-19).
   * O piso fixo (`.astro/`/`protectedPaths`, redação, confinamento) é aplicado
   * pelas próprias tools e não depende do modo; o hard-block de path (ADR-0027)
   * roda antes da MATRIX e vale em todos os modos, `bypass` incluso.
   */
  private async permissionGate(
    ctx: ToolContext,
    tool: Tool,
    call: ToolCall,
    input: unknown,
  ): Promise<ToolResult | undefined> {
    // Hard-block de path (ADR-0027, #391 slice 1): precedência sobre a MATRIX —
    // `hard-block` é deny em todos os modos, inclusive `bypass`.
    const hardBlocked = this.hardBlockGate(ctx, call, input);
    if (hardBlocked !== undefined) return hardBlocked;

    const action = actionClassOf(tool, { name: call.name, input }, (path) =>
      classifyPath({ realPath: path, cwd: ctx.cwd, astroHome: resolveAstroHome(), protectedPaths: ctx.protectedPaths ?? [], artifactRoot: resolveArtifactRoot(), allowCritical: ctx.allowCritical ?? [], allowSensitive: ctx.allowSensitive ?? [] }));
    // Tool-owned policy (#599): ordered shell rules and the scanner decide before
    // the matrix. `deny` is final in every mode; `ask` survives `ask`/`allow-edits`
    // and `bypass` asks nothing, as before.
    const hint = tool.permissionHint?.(input, ctx);
    const decision: PermissionDecision = hint?.decision === "deny"
      ? "deny"
      : hint?.decision === "ask" && this.mode !== "bypass"
        ? "ask"
        : hint?.decision === "allow"
          ? "allow"
          : permissionDecision(this.mode, action);
    let effective: PermissionDecision = decision;
    const grantKey = PermissionGrants.key(action, call.name);
    if (decision === "ask" && this.permissionGrants.has(grantKey) && !requiresPerCallApproval(action)) {
      // Grant de sessão ainda vale (PERM-05, #266): allow sem perguntar de novo.
      // Exceção #474: shell no host exige prompt por comando, sem grant de sessão.
      effective = "allow";
    } else if (decision === "ask") {
      try {
        const annex = editDiffAnnex(call, input);
        // #536: comando/path da chamada, já redacted e truncado, para a decisão
        // ser informada. Só o argumento material; conteúdo e env nunca entram.
        // #578: a tool que conhece o comando fora do input (`run_tests`) fornece
        // o próprio detalhe, normalizado aqui antes de chegar ao prompt.
        const supplied = tool.approvalDetail?.(input, ctx);
        const detail = supplied === undefined
          ? approvalDetailOf({ name: call.name, input })
          : normalizeApprovalDetail(supplied);
        const outcome = await this.awaitApproval(ctx, {
          name: call.name,
          action,
          mode: this.mode,
          ...(detail === undefined ? {} : { detail }),
          ...(annex === undefined ? {} : { diff: annex }),
          ...(requiresPerCallApproval(action) ? { perCall: true } : {}),
        });
        // Espera sem resposta morre no teto (#526): recusa como deny, audita e o run segue.
        if (outcome === TIMEOUT) {
          this.auditRef.append({
            run: ctx.run,
            agent: ctx.agent,
            tipo: "permission.timed_out",
            payload: { name: call.name, action, mode: this.mode, timeoutMs: this.approvalWaitTimeoutMs },
          });
          // Mesmo par de eventos de um deny comum (#526): quem conta negações por
          // `permission.decision` não subconta a expiração.
          this.auditRef.append({
            run: ctx.run,
            agent: ctx.agent,
            tipo: "permission.decision",
            payload: { name: call.name, action, mode: this.mode, decision: "deny" },
          });
          this.auditRef.append({
            run: ctx.run,
            agent: ctx.agent,
            tipo: "tool.denied",
            payload: { name: call.name, reason: "aprovação expirada" },
          });
          return failure(
            `aprovação expirada: a tool "${call.name}" não foi aprovada em ${this.approvalWaitTimeoutMs}ms (permissions.approvalTimeoutMs)`,
            "timeout",
          );
        }
        if (outcome === ABORTED) {
          return failure(`cancelado: a tool "${call.name}" foi interrompida`, "failed");
        }
        // Fail-closed: sem aprovador, `ask` vira deny (#262).
        if (outcome === "session") {
          this.permissionGrants.grant(grantKey);
          effective = "allow";
        } else {
          effective = outcome === undefined || outcome === false ? "deny" : "allow"; // true | "once"
        }
      } catch (error) {
        // Sem TTY o aprovador não pode perguntar: pending, auditado e run para (I-08/I-19).
        if (error instanceof PermissionPendingError) {
          this.auditRef.append({
            run: ctx.run,
            agent: ctx.agent,
            tipo: "permission.pending",
            payload: { name: call.name, action, mode: this.mode },
          });
        }
        throw error;
      }
    }
    // `allow` automático só é auditado em bypass (#268): nele toda decisão fica rastreável.
    // A rule allow also carries its origin (#599 review): the source is auditable.
    if (decision !== "allow" || this.mode === "bypass" || hint?.origin !== undefined) {
      this.auditRef.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "permission.decision",
        payload: {
          name: call.name, action, mode: this.mode, decision: effective,
          ...(hint?.origin === undefined ? {} : { origin: hint.origin }),
          ...(hint?.code === undefined ? {} : { reason: hint.code }),
        },
      });
    }
    if (effective !== "deny") return undefined;

    const reason = `permissão negada para a tool "${call.name}" (modo ${this.mode}, ação ${action})`;
    this.auditRef.append({
      run: ctx.run,
      agent: ctx.agent,
      tipo: "tool.denied",
      payload: { name: call.name, reason, ...(hint?.code === undefined ? {} : { code: hint.code }) },
    });
    // A tool policy deny carries its own sanitized guidance (#599); no raw command.
    if (hint?.decision === "deny" && hint.message !== undefined) {
      return { ...failure(hint.message, "denied"), ...(hint.code === undefined ? {} : { code: hint.code }) };
    }
    return failure(reason, "denied");
  }

  /**
   * Caminhos materiais da chamada para o `tool.call` (#535): só `delete`/`edit`
   * (as classes que mudam o FS) declaram o que tocam. Cada path passa por
   * `redactSecrets` e é truncado — nunca há conteúdo de arquivo no payload
   * (I-03). Input ilegível não vira evento quebrado: devolve vazio.
   */
  private callPaths(call: ToolCall): string[] {
    const tool = this.byName.get(call.name);
    const cls = tool?.manifest?.class;
    if (cls !== "delete" && cls !== "edit") return [];
    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      return [];
    }
    return pathCandidatesOf({ name: call.name, input })
      .map((path) => redactSecrets(path).slice(0, AUDIT_PATH_MAX_CHARS));
  }

  /**
   * Gate de hard-block por path (ADR-0027, #391 slice 1): classifica o realpath
   * de cada candidato do input via `classifyPath`; `hard-block` (imutável ou
   * configurável) é DENY antes da MATRIX em todos os modos, `bypass` incluso.
   * A negação cita path + classe, nunca conteúdo (I-03). `allowCritical` vem da flag de CLI (s5a) via `ctx.allowCritical`.
   */
  private hardBlockGate(ctx: ToolContext, call: ToolCall, input: unknown): ToolResult | undefined {
    const candidates = pathCandidatesOf({ name: call.name, input });
    if (candidates.length === 0) return undefined;
    const astroHome = resolveAstroHome();
    const artifactRoot = resolveArtifactRoot();
    const allowCritical = ctx.allowCritical ?? [];
    const allowSensitive = ctx.allowSensitive ?? [];
    const classify = (realPath: string, critical: readonly string[], sensitive: readonly string[]): PathClass =>
      classifyPath({ realPath, cwd: ctx.cwd, astroHome, protectedPaths: ctx.protectedPaths ?? [], artifactRoot, allowCritical: critical, allowSensitive: sensitive });
    for (const candidate of candidates) {
      let pathClass: PathClass;
      try {
        pathClass = classify(candidate, allowCritical, allowSensitive);
        const onlyAllow = allowCritical.length > 0 || allowSensitive.length > 0
          ? classify(candidate, [], [])
          : pathClass;
        const display = denyDisplayPath(ctx.cwd, candidate);
        // Audit por match (ADR-0027): classe só POR allow; path via denyDisplayPath (I-03).
        if (pathClass === "normal" && allowCritical.length > 0 && onlyAllow === "hard-block") {
          this.auditRef.append({ run: ctx.run, agent: ctx.agent, tipo: "security.allowlist_applied",
            payload: { name: call.name, entry: display, result: "applied", origin: "cli", rule: "allow-critical", class: pathClass } });
        } else if (pathClass === "sensitive" && allowSensitive.length > 0 && onlyAllow === "normal") {
          this.auditRef.append({ run: ctx.run, agent: ctx.agent, tipo: "security.allowlist_applied",
            payload: { name: call.name, entry: display, result: "applied", origin: "cli", rule: "allow-sensitive", class: pathClass } });
        }
      } catch (error) {
        if (error instanceof AllowlistInvalidError) {
          // deny tipado existente (allow_invalid); cita só a entrada, sem conteúdo (I-03)
          this.auditRef.append({
            run: ctx.run,
            agent: ctx.agent,
            tipo: "tool.denied",
            payload: { name: call.name, reason: error.code, entry: error.entry },
          });
          return { ...failure(`entrada de allowlist inválida (${error.code}): ${error.entry}`, "denied"), code: error.code };
        }
        // fail-closed: caminho que não classifica não é liberado (ADR-0027)
        this.auditRef.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "tool.denied",
          payload: { name: call.name, reason: PATH_HARD_BLOCKED },
        });
        const display = denyDisplayPath(ctx.cwd, candidate);
        const blocked = new PathHardBlockedError(display, `caminho não classificável; negado por fail-closed (${PATH_HARD_BLOCKED}): ${display}`);
        return { ...failure(blocked.message, "denied"), code: blocked.code };
      }
      if (pathClass === "hard-block") {
        this.auditRef.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "tool.denied",
          payload: { name: call.name, reason: PATH_HARD_BLOCKED },
        });
        const blocked = new PathHardBlockedError(denyDisplayPath(ctx.cwd, candidate));
        return { ...failure(blocked.message, "denied"), code: blocked.code };
      }
    }
    return undefined;
  }

  /** Cap de saída por tool (CMP-10): head+tail+origem, artefato em `.astro/outputs`. */
  private limitOutput(ctx: ToolContext, call: ToolCall, result: ToolResult): ToolResult {
    const capTokens = ctx.outputLimitTokens;
    if (capTokens === undefined || result.output.length === 0) return result;
    // O artefato de handoff é parseado pela sessão antes de virar mensagem e já
    // é compactado (compactDraft); truncar aqui perderia o handoff em silêncio.
    if (call.name === "handoff") return result;
    const limited = limitToolOutput(result.output, {
      capTokens,
      toolCallId: call.id,
      artifactDir: join(ctx.cwd, ".astro", "outputs", safeRunDir(ctx.run)),
      displayPath: (path) => relative(ctx.cwd, path),
    });
    // A sanitização para o contexto acontece na sessão; aqui o truncamento
    // precisa preservar a saída bruta para handoff/paths/ids.
    return limited.truncated ? { ...result, output: limited.output } : result;
  }
}
