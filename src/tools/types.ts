import type { CallJournal } from "../call-id";
import type { AgentPermission, ApprovalDetail, PermissionMode } from "../permissions";

/** Efeitos externos que a tool pode causar (F-10, I-12): vocabulário fechado. */
export type SideEffects = "none" | "filesystem" | "network" | "process";

/** Classe de ação para o gate de permissão (PERM-02, #264): vocabulário fechado. */
export type ToolClass =
  | "read_common"
  | "read_critical"
  | "edit"
  | "delete"
  | "shell"
  | "identity_swap";

const TOOL_CLASS_SET: ReadonlySet<string> = new Set([
  "read_common", "read_critical", "edit", "delete", "shell", "identity_swap",
]);

/** Guard de runtime: manifestos de plugin não passam pelo typechecker (#264). */
export function isToolClass(value: unknown): value is ToolClass {
  return typeof value === "string" && TOOL_CLASS_SET.has(value);
}

/** Metadados obrigatórios de uma tool (I-12). */
export interface ToolManifest {
  name: string;
  description: string;
  parameters: object;
  risk: "low" | "medium" | "high";
  permission: string;
  /** Classe de ação consumida pelo gate (PERM-01); escrita/leitura crítica refinam por caminho. */
  class: ToolClass;
  timeoutMs: number;
  retryable: boolean;
  /** Repetir a mesma chamada deixa o sistema no mesmo estado (F-10). */
  idempotent: boolean;
  /** O que a tool pode mutar fora da conversa (F-10). */
  sideEffects: SideEffects;
  /** Teto de saída declarado pela tool (S6, #603); ausente = sem teto próprio. */
  output?: ToolOutputCeiling;
}

/** Teto de saída de uma tool (S6, #603). */
export interface ToolOutputCeiling {
  /** Teto em tokens estimados (~4 chars/token), o mesmo estimador do CMP-10. */
  maxTokens: number;
  /** Como o modelo pede o restante omitido. */
  hint: string;
}

/** Live tool signal for the turn observer (#600); absent = no observer. */
export type ToolLifecycleEvent =
  | { phase: "start"; callId: string; name: string; arguments: string }
  | { phase: "end"; callId: string; isError: boolean; durationMs: number };

/**
 * Contexto de execução de uma tool.
 *
 * `executor` é injetado pelo ToolExecutor ao chamar `tool.execute` e permite que
 * tools de composição (ex.: pipeline) executem sub-tools respeitando a MESMA
 * allowlist do agent (I-01), timeout por manifesto e auditoria. Tools comuns
 * ignoram o campo.
 */
export interface ToolContext {
  cwd: string;
  run: string;
  agent: string;
  /** Ambiente do run; `run_command` usa este mapa em vez de `process.env` quando presente. */
  env?: Record<string, string | undefined>;
  /** Caminhos que tools de escrita não podem alterar (ledger/auditoria). */
  protectedPaths?: readonly string[];
  /** Nomes exatos de variáveis que devem ser removidos do shell (ex.: credentialRef). */
  secretEnvNames?: readonly string[];
  /** Executor da sessão; presente apenas quando chamado via ToolExecutor. */
  executor?: ToolExecutorLike;
  /** Cancelamento cooperativo (TUI/`!cmd`): a tool deve encerrar o trabalho. */
  signal?: AbortSignal;
  /** Step corrente da sessão; presente quando a sessão habilita dedup (F-03). */
  step?: number;
  /** Journal de resultados por call_id; presente quando a sessão habilita dedup (F-03). */
  journal?: CallJournal;
  /** Agents nomeados disponíveis; permite à tool handoff validar o destino (F-23). */
  knownAgents?: readonly string[];
  /** Allowlist efetiva do agente corrente (I-02): teto para spawn de subagente. */
  allow?: readonly string[];
  /** Teto de passos do agente corrente: subagente nunca recebe mais. */
  maxSteps?: number;
  /** Teto de tokens por saída (CMP-10), já resolvido para o modelo corrente. */
  outputLimitTokens?: number;
  /** Perfil de permissão do executor que está chamando a tool (#58). */
  permission?: AgentPermission;
  /** Allowlist `allow-critical` da CLI (ADR-0027, #391 slice 5a): realpaths absolutos que liberam o tier configurável. */
  allowCritical?: readonly string[];
  /** Allowlist `allow-sensitive` da CLI (ADR-0027): promove normal para sensitive no gate/read_file. */
  allowSensitive?: readonly string[];
  /** Live tool signal for the turn observer (#600); absent = no observer. */
  onToolEvent?: (event: ToolLifecycleEvent) => void;
}

/**
 * Superfície do executor que tools de composição podem usar.
 * Definida aqui (em vez de importar ToolExecutor) para evitar import cíclico.
 */
export interface ToolExecutorLike {
  run(ctx: ToolContext, call: { id: string; name: string; arguments: string }): Promise<ToolResult>;
  defs(): { name: string; description: string; parameters: object }[];
  /** Auditoria da sessão, para tools de composição logarem eventos próprios. */
  audit: AuditLike;
  /**
   * Modo de permissão resolvido do executor (#474). O host lê daqui - nunca de
   * estado global - para decidir a confirmação extra de `bypass`.
   */
  readonly permissionMode?: PermissionMode;
}

/** Superfície do Auditor para tools de composição. */
export interface AuditLike {
  append(event: { run: string; agent?: string; tipo: string; payload?: Record<string, unknown> }): unknown;
}

/** Resultado de uma tool; erros voltam ao modelo como resultado, não como exceção. */
export interface ToolResult {
  output: string;
  isError?: boolean;
  /** Código estável de erro de política (ADR-0027): path_hard_blocked, allow_invalid, sandbox_required_for_shell, invalid_manifest. */
  code?: string;
  /** Código estável da taxonomia (S6, #603); `code` continua sendo o motivo de política. */
  failure?: ToolFailure;
  /** O que foi omitido e como pedir o restante (S6, #603). */
  truncation?: TruncationInfo;
}

/** Taxonomia fechada de falha (S6, #603): código estável, nunca prosa. */
export type ToolFailure = "denied" | "failed" | "timeout" | "invalid";

/** O que um truncamento removeu e como recuperar (S6, #603). */
export interface TruncationInfo {
  removed: number;
  total: number;
  /** Unidade dos números: `entries`, `results`, `lines`. */
  unit: string;
  hint: string;
}

/**
 * Decision the tool owns before the permission matrix (#599): ordered shell
 * rules and the compound scanner run here, so an explicit `deny` survives every
 * mode and saved approval. The executor still applies the path hard-block first.
 */
export interface ToolPermissionHint {
  decision: "allow" | "ask" | "deny";
  /** Stable policy code for a deny (never the raw command). */
  code?: string;
  /** Sanitized message for a deny; never the raw command. */
  message?: string;
  /** Policy origin for the audit record (#599 review). */
  origin?: "rule" | "external_directory" | "unparsable" | "approval" | "consent";
}

/** Sanitized record of a tool-owned decision (#599); shell decisions hash the command. */
export interface ToolDecisionAudit {
  decision: "allow" | "ask" | "deny";
  origin?: ToolPermissionHint["origin"] | "mode";
  grant?: "once" | "always";
  /** `always` was requested but the prefix could not be persisted. */
  degraded?: boolean;
  /** Stable reason code; never the command. */
  reason?: string;
}

/** Result of persisting an `always` approval (#599); failure carries a stable reason. */
export type ApprovalSave =
  | { ok: true; pattern: string }
  | { ok: false; reason: string };

/** Contrato de uma tool executável pelo agente. */
export interface Tool {
  manifest: ToolManifest;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** Tool-owned policy before the mode matrix (#599); absent = matrix only. */
  permissionHint?(input: unknown, ctx: ToolContext): ToolPermissionHint | undefined;
  /**
   * Sanitized audit record of the decision the tool owns (#599): the executor
   * appends `{ tipo, payload }` for every shell decision. The payload carries a
   * command hash, never the command or the output (D-11, I-03).
   */
  decisionAudit?(
    input: unknown,
    ctx: ToolContext,
    outcome: ToolDecisionAudit,
  ): { tipo: string; payload: Record<string, unknown> } | undefined;
  /**
   * Detalhe material da chamada para o prompt de aprovação (#536, #578) quando
   * ele não está no input — `run_tests` executa o comando da config, não do
   * modelo. O executor normaliza (uma linha, redigido, truncado) antes do
   * prompt; devolver `undefined` volta ao mapeamento por nome.
   */
  approvalDetail?(input: unknown, ctx?: ToolContext): ApprovalDetail | undefined;
  /**
   * Persists an `always` approval for this call (#599) and returns the stored
   * prefix pattern. Only tools whose policy owns a saved list implement it.
   * `session` never reaches this hook: only an explicit `always` may persist.
   */
  rememberApproval?(input: unknown, ctx: ToolContext): ApprovalSave | undefined;
}

/** Erro de validação ou de política de uma tool. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * Recusa de política (S6, #603): o caminho foi negado por confinamento, não por
 * entrada malformada. O executor mapeia por causa, não por classe.
 */
export class ToolDeniedError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = "ToolDeniedError";
  }
}
