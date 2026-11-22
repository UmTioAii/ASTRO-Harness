import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CAPABILITY_KEYS, isKnownCapability, missingCapabilities, type Capability } from "../capabilities";
import { PROTECTED_FORBIDDEN_ROOTS, DEFAULT_EFFORT_ESCALATION, MAX_AUTO_JUMP, MAX_EFFORT_LEVEL, type CallConfig, type EffortEscalationConfig, type EffortLevel, type ThinkingMode } from "../call-profile";
import { DEFAULT_OUTPUT_LIMIT, type OutputLimitConfig } from "../output-limit";
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from "../compaction/engine";
import type { ModelRouting } from "../providers/model-routing";
import { DEFAULT_RUN_TESTS_TIMEOUT_MS, MAX_RUN_TESTS_TIMEOUT_MS, type RunTestsConfig } from "../tools/run-command";
import { HOST_SHELLS, isHostShell } from "../tools/host-shell";
import type { WebSearchConfig, WebSearchProvider } from "../tools/web-search";
import { isPermissionMode, DEFAULT_PERMISSION_MODE, isAgentPermission, type AgentPermission, type PermissionMode } from "../permissions";
import { isAuthHeader, isEnvName, isVaultCredentialRef, looksLikeSecret, mcpSecretProblem } from "../secrets";
import { headerEnvName, isValidHeaderName } from "../mcp/headers";
import { outboundUrlProblem, urlProblem } from "../url-safety";
import { CAPACITY_TAGS, ROLE_TAGS, isKnownTag } from "../tags";
import { isJudgeMode, type JudgeMode } from "../judge";
import { checkpointIdProblem } from "../loop-guard";
import { DEFAULT_MEMORY_MAX_CHARS, MIN_MEMORY_MAX_CHARS } from "../memory";
import { hardenWindowsAclFile } from "../attachments/acl";

/** Configuração comum a todos os providers. */
interface ProviderConfigBase {
  /** Rótulo de exibição (TUI/REPL); não muda o id/chave do provider (#492). */
  name?: string;
  /** Domínio de quota compartilhado entre credenciais (default: "default"). */
  quotaDomain?: string;
  /** Headers extras enviados ao provider (ex.: HTTP-Referer, X-Title). */
  headers?: Record<string, string>;
  /** Ordem na cadeia de fallback (C6); menor atende primeiro. Default 100 (D-15). */
  priority?: number;
  /** Providers a tentar em falha (C6, D-14); `[]` desabilita o fallback. */
  fallback?: string[];
  /** Retries por provider além da primeira tentativa (C6). Default 2. */
  maxRetries?: number;
  /** Base do backoff linear entre retries em ms (C6). Default 1000. */
  retryBackoffMs?: number;
  /** Timeout de rede por tentativa em ms; default 120000 (I-09). */
  timeoutMs?: number;
  /** Teto total opcional de uma chamada com streaming em ms; ausente = sem teto (#519). */
  streamTimeoutMs?: number;
}

/** Provider OpenAI-compatible (NVIDIA NIM, OpenRouter). */
export interface OpenAICompatProviderConfig extends ProviderConfigBase {
  kind: "openai-compat";
  baseUrl: string;
  /** Nome da variável de ambiente que guarda a chave. Nunca o valor. Ausente = provider sem chave. */
  credentialRef?: string;
}

/** Provider Codex via OAuth (Responses API). */
export interface CodexOAuthProviderConfig extends ProviderConfigBase {
  kind: "codex-oauth";
  credentialsPath: string;
  baseUrl?: string;
}

/** Configuração de provider fornecida por plugin (F7-1): kind custom, shape opaco. */
export interface PluginProviderConfig extends ProviderConfigBase {
  /** Qualquer kind que não seja openai-compat/codex-oauth; a factory vive no plugin. */
  kind: string;
  [key: string]: unknown;
}

/** União discriminada por `kind`. */
export type ProviderConfig = OpenAICompatProviderConfig | CodexOAuthProviderConfig | PluginProviderConfig;

export interface PriceConfig {
  inputPerM: number;
  outputPerM: number;
  fonte: string;
  verificado: boolean;
}

export type ModelStatus = "active" | "deprecated" | "disabled";

export interface ModelConfig {
  provider: string;
  id: string;
  tags: string[];
  context: number;
  status?: ModelStatus;
  price?: PriceConfig;
  /** Matriz de capability (F-07): chaves do vocabulário fechado; ausente = não tem. */
  capabilities?: Partial<Record<Capability, boolean>>;
  /** Call profile (E1–E8): effort, thinking e parâmetros proibidos. */
  call?: CallConfig;
  /** Eficiência relativa (M6/M8): maior primeiro; usada só quando falta preço. */
  efficiency?: number;
}

/** Profile da model pool (F-27, ADR-0007): alias declarativo para um modelo de `models[]`. */
export interface ProfileConfig {
  /** Modelo resolvido: precisa existir em "models" e estar active. */
  model: string;
  /** Capabilities exigidas do modelo (F-07); validadas no startup. */
  capabilities?: Capability[];
  /** Profiles alternativos (F-31); `[]` desabilita, igual a ausente. */
  fallback?: string[];
}

/** Configuração de um agent (pode ser o principal ou um agent nomeado em `agents`). */
export interface AgentConfig {
  model: string;
  maxSteps: number;
  tools: string[];
  systemPrompt?: string;
  /** Agent inicial para sessão multi-agent (default: "planner"). */
  entryAgent?: string;
  /** Profile da model pool (F-27, ADR-0007); substitui `model` quando definido. */
  profile?: string;
}

/**
 * Teto padrão de passos (#515): 500 é o default do preset `simple` e o default
 * quando a config não declara `agent.maxSteps` no preset `control`.
 */
export const BASELINE_MAX_STEPS = 500;

/**
 * Allowlist herdada quando `agent.tools` é omitido (P3): é exatamente o
 * conjunto que o modo zero-config expõe, então omitir não muda o contrato.
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "edit",
  "grep",
  "list_dir",
  "run_command",
];

/**
 * Preset de configuração (#515): `simple` fixa os passos em 500 por tarefa e
 * não aceita esse knob; `control` expõe `agent.maxSteps`.
 */
export type Preset = "default" | "simple" | "control";

export const PRESETS: readonly Preset[] = ["default", "simple", "control"];

/** Product profile used when the config does not declare one. */
export const DEFAULT_PRESET: Preset = "default";

/** Limite do preset `simple` (#515). */
export const SIMPLE_MAX_STEPS = 500;

/** Valida `preset`; desconhecido falha em vez de cair no default. */
function validatePreset(value: unknown): Preset {
  if (value === undefined) return DEFAULT_PRESET;
  if (value === "default" || value === "simple") return "default";
  if (value === "control") return value;
  return fail('config inválida: "preset" deve ser "default", "simple" ou "control"');
}

const DERIVED_PRESET = Symbol("astro.derivedPreset");
const isDerivedPreset = (value: Record<string, unknown>): boolean =>
  (value as Record<symbol, unknown>)[DERIVED_PRESET] === true;

/** Preserve an omitted preset when already validated configs are used as layers. */
export function mergeDerivedPresetMetadata(
  base: Record<string, unknown>, overlay: Record<string, unknown>, merged: Record<string, unknown>,
): void {
  const before = isDerivedPreset(base);
  const after = isDerivedPreset(overlay);
  if (!before && !after) return;
  const useBase = Object.hasOwn(base, "preset") && (!Object.hasOwn(overlay, "preset") || after);
  if (useBase) merged.preset = base.preset;
  if ((useBase && before) || (!useBase && after)) Object.defineProperty(merged, DERIVED_PRESET, { value: true });
}

/**
 * Preset `simple`: teto de 500. Uma camada mais restritiva (global/projeto com
 * 30, por exemplo) continua valendo; acima de 500 é erro com o próximo passo.
 */
function applySimplePreset(root: Record<string, unknown>): Record<string, unknown> {
  const check = (field: string, value: unknown): void => {
    if (value === undefined) return;
    // The regular validator owns type/range errors; the profile only enforces its ceiling.
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return;
    if (value <= SIMPLE_MAX_STEPS) return;
    fail(
      `config inválida: "${field}" só pode ser alterado com "preset": "control" ` +
        `(no Default o teto é ${SIMPLE_MAX_STEPS})`,
    );
  };

  // Limites novos do #552 são exclusivos do preset `control` (simple fica read-only).
  const controlOnly = (field: string, value: unknown): void => {
    if (value === undefined) return;
    fail(`config inválida: "${field}" só pode ser alterado com "preset": "control"`);
  };

  const agent = root.agent !== null && typeof root.agent === "object"
    ? (root.agent as Record<string, unknown>)
    : undefined;
  check("agent.maxSteps", agent?.maxSteps);

  const agents = root.agents !== null && typeof root.agents === "object"
    ? (root.agents as Record<string, unknown>)
    : undefined;
  for (const [name, entry] of Object.entries(agents ?? {})) {
    if (entry === null || typeof entry !== "object") continue;
    check(`agents.${name}.maxSteps`, (entry as Record<string, unknown>).maxSteps);
  }
  controlOnly("agents.maxActive", agents?.maxActive);

  const spawn = root.spawn !== null && typeof root.spawn === "object"
    ? (root.spawn as Record<string, unknown>)
    : undefined;
  controlOnly("spawn.maxActive", spawn?.maxActive);

  const team = root.team !== null && typeof root.team === "object"
    ? (root.team as Record<string, unknown>)
    : undefined;
  controlOnly("team.sessionBudgetUsd", team?.sessionBudgetUsd);
  controlOnly("team.weekBudgetUsd", team?.weekBudgetUsd);

  const run = root.run !== null && typeof root.run === "object"
    ? (root.run as Record<string, unknown>)
    : undefined;
  if (run === undefined || !isDerivedRunLimit(run, "maxRoundsPerTurn")) {
    controlOnly("run.maxRoundsPerTurn", run?.maxRoundsPerTurn);
  }

  // Só injeta quando `agent` é objeto: entrada de tipo errado segue para o
  // validador normal, que reporta a causa certa (nunca mascara o erro).
  if (agent === undefined || agent.maxSteps !== undefined) return root;
  return {
    ...root,
    agent: { ...agent, maxSteps: SIMPLE_MAX_STEPS },
  };
}

/** Configuração de agents nomeados (para multi-agent F3+). Campos opcionais herdam do agent principal. */
export interface NamedAgentConfig {
  model: string;
  maxSteps?: number;
  tools?: string[];
  systemPrompt?: string;
  /** Profile da model pool (F-27, ADR-0007); substitui `model` quando definido. */
  profile?: string;
  /** Perfil de permissão do agente (#58); ausente = "full" (compat). */
  permission?: AgentPermission;
  /** Roteamento barato/forte por propósito (#58); ausente = modelo do agente. */
  modelRouting?: ModelRouting;
}

/** Configuração de tools específicas (por nome da tool). */
export interface ToolsConfig {
  run_command?: RunCommandToolConfig;
}

export interface RunCommandToolConfig {
  /**
   * Modo do shell (#474): ausente e `"auto"` = Docker quando disponível, senão
   * host com aprovação por comando (default); `true`/`"docker"` = só container
   * Docker; `false` = shell desligado (I-19).
   */
  sandbox?: boolean | "auto" | "docker";
}

/** Host shell selection; `mode` is the schema 2 replacement for `sandbox`. */
export interface ShellConfig {
  default?: string;
  mode?: "host" | "off";
}

/** Telemetria opt-in (F5-5): métricas anônimas por run; off por default. */
export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  /** Fração de runs enviados, 0..1 (default: 1). */
  sampleRate: number;
}

/** Limite de quota por quotaDomain (F6-3); pelo menos um campo. */
export interface QuotaLimitConfig {
  dailyTokens?: number;
  monthlyCostUsd?: number;
}

/** Completion cache (F6-4): off por default; SQLite em .astro/cache.db. */
export interface CacheConfig {
  enabled: boolean;
  ttlHours: number;
  maxEntries: number;
}

/** Escopo do budget (B1, D-CFG1). */
export type BudgetScope = "day" | "month" | "project" | "use-as-you-go";

/** Ação no esgotamento (B4): perguntar (com checkpoint sem TTY) ou parar. */
export type BudgetOnExceed = "ask" | "stop";

/** Budget (B1–B10, I-17): escopo, aviso, decisão e corte físico. */
export interface BudgetConfig {
  scope: BudgetScope;
  /** null = use-as-you-go (B2): registra e exibe, nunca bloqueia. */
  limitUsd: number | null;
  /** Fração de aviso (0 < warnAt < 1); default 0.8. */
  warnAt: number;
  /** Default "ask". */
  onExceed: BudgetOnExceed;
  /** Corte físico (B10, I-17); ausente = sem teto absoluto. */
  hardCeilingUsd?: number;
}

export type RunLimit = number | "unlimited";

/** Session limits always exist; legacy loop guards require an explicit `run` section. */
export interface RunConfig {
  /** Maximum user turns in a chat session. */
  maxTurns: RunLimit;
  /** Maximum model/tool rounds within one turn. */
  maxRoundsPerTurn: RunLimit;
  /** Fraction of the round limit at which a checkpoint is written. */
  checkpointAt?: number;
  /** Consecutive unchanged segments that pause the loop. */
  noProgressSegments?: number;
  /** Loop judge: off, on every completion, or automatic by signal. */
  judge?: JudgeMode;
  /** Project test command as argv; absent means no auto-detection. */
  tests?: RunTestsConfig;
}

/** Seção `attachments` (ADR-0026, #392): imagem, diretório e artifact store. */
export interface AttachmentsConfig {
  image: { autoResize: boolean };
  directory: { showHidden: boolean };
  /** TTL do artifact store em dias; default 7. */
  artifactTtlDays: number;
  /** Teto do artifact store em bytes; default 1 GiB. */
  artifactMaxBytes: number;
}

/** Team features (F7-5): budget do projeto, orçamentos por sessão/semana (#552), quotas por agent, webhook de auditoria. */
export interface TeamSectionConfig {
  projectBudgetUsd?: number;
  /** Orçamento da sessão (run) corrente em USD (#552); só no preset `control`. */
  sessionBudgetUsd?: number;
  /** Orçamento da semana ISO corrente em USD (#552); só no preset `control`. */
  weekBudgetUsd?: number;
  agentQuotas?: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }>;
  auditWebhook?: string;
}

/** Handoff (F-24): timeout do ack de recebimento (D-15). */
export interface HandoffConfig {
  ackTimeoutMs: number;
}

/** Default do timeout de ack (F-24, D-15). */
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** Seção `spawn` (A11, ADR-0008): paralelismo é opt-in; serial é o default. */
export interface SpawnConfig {
  parallel?: boolean;
  /** Teto de spawns por run (#552); ausente = DEFAULT_MAX_SPAWNS_PER_RUN; só no preset `control`. */
  maxActive?: number;
}

/** Permissões por chamada de tool (PERM-01): modo global do harness. */
export interface PermissionsConfig {
  mode: PermissionMode;
  /**
   * Teto da espera por aprovação humana em ms (#526); `0` desliga e ausente
   * usa o default do executor (300000). Sem teto, um prompt esquecido prende o
   * run e a conta exclusiva que ele segura.
   */
  approvalTimeoutMs?: number;
}

/** Nome da env que sobrescreve `security.entropyThreshold` (ADR-0027, #391 slice 3b). */
export const ENTROPY_THRESHOLD_ENV = "ASTRO_ENTROPY_THRESHOLD";

/**
 * Default conservador do limiar de entropia em bits/char (ADR-0027 slice 3b):
 * base64 aleatória ~6, hex ~4, texto natural < ~4.2. É só default de config,
 * nunca bypass do gate — valor inválido falha fechado.
 */
export const DEFAULT_ENTROPY_THRESHOLD = 4.5;

/**
 * Teto do limiar: acima de 8 bits/char o gate seria inefetivo para conteúdo
 * byte-oriented (equivaleria a desligá-lo), então é inválido e falha fechado.
 */
export const MAX_ENTROPY_THRESHOLD = 8;

/** Seção `security` (ADR-0027): configurações de segurança do harness. */
export interface SecurityConfig {
  /**
   * Entropia (bits/char) a partir da qual o conteúdo de um path `sensitive`
   * é negado no `read_file` (ADR-0027 slice 3b). Opcional; default
   * `DEFAULT_ENTROPY_THRESHOLD`. A env `ASTRO_ENTROPY_THRESHOLD` vence a config.
   */
  entropyThreshold?: number;
}

function isValidEntropyThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_ENTROPY_THRESHOLD;
}

/**
 * Resolve o limiar de entropia efetivo (bits/char) para o tier `sensitive`
 * (ADR-0027, #391 slice 3b). Precedência: env `ASTRO_ENTROPY_THRESHOLD` >
 * `security.entropyThreshold` da config > `DEFAULT_ENTROPY_THRESHOLD`.
 *
 * Devolve `null` quando a fonte vencedora é inválida (fail-closed: o caller
 * deve negar a leitura em `sensitive`, nunca cair para um valor mais frouxo).
 */
export function resolveEntropyThreshold(source?: {
  config?: SecurityConfig | null;
  env?: Record<string, string | undefined> | null;
}): number | null {
  const rawEnv = source?.env?.[ENTROPY_THRESHOLD_ENV]?.trim();
  if (rawEnv !== undefined && rawEnv !== "") {
    const parsed = Number(rawEnv);
    return isValidEntropyThreshold(parsed) ? parsed : null;
  }
  const fromConfig = source?.config?.entropyThreshold;
  if (fromConfig !== undefined) {
    return isValidEntropyThreshold(fromConfig) ? fromConfig : null;
  }
  return DEFAULT_ENTROPY_THRESHOLD;
}

/** Servidor MCP (C2, #56): o `command` do stdio é código arbitrário — modelo de confiança na doc. */
export interface MCPServerConfig {
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  /** Variáveis explícitas para o servidor; o resto do env é sanitizado (I-03). */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Base do backoff exponencial entre reconexões em ms; teto de 30s (default 1000). */
  retryBackoffMs?: number;
  timeoutMs: number;
  enabled: boolean;
}

export interface PathsConfig {
  ledger: string;
  audit: string;
}

/** `paths` omitido herda onde o modo zero-config grava; mesma semântica de `DEFAULT_AGENT_TOOLS`. */
export const DEFAULT_PATHS: Readonly<PathsConfig> = {
  ledger: ".astro/ledger.jsonl",
  audit: ".astro/audit.jsonl",
};

/** Memória persistida (#532): teto de caracteres injetados no system prompt. */
export interface MemoryConfig {
  maxChars: number;
}

export interface AstroConfig {
  /** Preset (#515): `simple` fixa 500 passos/turnos; `control` expõe os knobs. */
  preset: Preset;
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
  /** Model pool (F-27, ADR-0007): profiles resolvem para modelos de `models[]`. */
  modelPool?: Record<string, ProfileConfig>;
  agent: AgentConfig;
  agents?: Record<string, NamedAgentConfig>;
  /** Teto declarado de agentes ativos (A2); v1 aplica no máximo 2. */
  maxActive?: number;
  tools?: ToolsConfig;
  /** Shell do host (#474): `default` é gravado por `/shell` depois do confirm. */
  shell?: ShellConfig;
  telemetry?: TelemetryConfig;
  /** Limites por quotaDomain (F6-3). */
  quota?: Record<string, QuotaLimitConfig>;
  /** Budget (B1–B10, I-17); ausente = sem camada de budget. */
  budget?: BudgetConfig;
  /** Seção `run` (Q-01): guardas do loop; o limite de trabalho vive em `agent.maxSteps`. */
  run?: RunConfig;
  /** Seção `attachments` (ADR-0026, #392): limites e comportamento de anexos. */
  attachments: AttachmentsConfig;
  cache?: CacheConfig;
  /** Caminhos ou pacotes de plugins a carregar (F7-1). */
  plugins?: string[];
  /** Versão semântica da config (x.y.z) para sharing (F7-4); ausente = legado. */
  version?: string;
  /** Versão de origem de uma migração em memória (ADR-0028); ausente = já no major. */
  migratedFrom?: string;
  /** Recursos de time (F7-5). */
  team?: TeamSectionConfig;
  /** Handoff (F-24): timeout do ack; default 30000ms (D-15). */
  handoff?: HandoffConfig;
  /** Fan-out de subagentes (A11): paralelo só com `parallel: true`. */
  spawn?: SpawnConfig;
  /** Permissões por chamada (PERM-01); default `ask`. */
  permissions: PermissionsConfig;
  /** Segurança (ADR-0027): limiar de entropia para o tier `sensitive`. */
  security?: SecurityConfig;
  /** Escalada automática de effort (M5, ADR-0024); ausente = off. */
  effort?: EffortEscalationConfig;
  /** Tabela de preços global (C6): key `provider/model-id` sobrescreve `model.price` para custo. */
  pricing?: Record<string, PriceConfig>;
  /** Servidores MCP (C2, #56): key é o nome usado no namespace mcp__<server>__<tool>. */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Limite de saída por tool (S-16, CMP-10); default 8000 tokens / 5% da janela. */
  outputLimit?: OutputLimitConfig;
  /** Compactação de sessão (S-17, CMP-1): buffer da janela; `null` = default. */
  compaction?: CompactionConfig;
  /** Ferramenta web_search (#57): backend, env da chave e resultados default. */
  webSearch?: WebSearchConfig;
  /** Memória persistida (#532): `maxChars` limita o que entra no system prompt. */
  memory?: MemoryConfig;
  paths: PathsConfig;
}

/** Códigos estáveis das falhas de save da config (#470); sem código = erro legado. */
export type ConfigErrorCode =
  | "config_not_found"
  | "config_read_denied"
  | "config_read_failed"
  | "config_write_denied"
  | "config_write_failed"
  | "config_invalid_json"
  | "config_invalid_schema"
  | "config_ahead_of_harness"
  | "config_migration_required"
  | "config_unknown_key";

export class ConfigError extends Error {
  /**
   * Código estável da falha; a propriedade só existe quando há código, porque
   * consumidores gateiam por shape (`"code" in error`).
   */
  declare readonly code?: ConfigErrorCode;
  constructor(message: string, code?: ConfigErrorCode) {
    super(message);
    this.name = "ConfigError";
    if (code !== undefined) this.code = code;
  }
}

const MODEL_STATUSES: readonly ModelStatus[] = ["active", "deprecated", "disabled"];

function fail(message: string): never {
  throw new ConfigError(message);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(`config inválida: "${field}" deve ser um objeto`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`config inválida: "${field}" deve ser uma string não vazia`);
  }
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    fail(`config inválida: "${field}" deve ser uma lista de strings`);
  }
  return value.map((item: unknown, index: number) => expectString(item, `${field}[${index}]`));
}

function expectNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`config inválida: "${field}" deve ser um número finito maior ou igual a zero`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`config inválida: "${field}" deve ser um inteiro positivo`);
  }
  return value;
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  const n = expectNonNegativeNumber(value, field);
  if (!Number.isInteger(n)) {
    fail(`config inválida: "${field}" deve ser um inteiro não negativo`);
  }
  return n;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    fail(`config inválida: "${field}" deve ser booleano`);
  }
  return value;
}

/**
 * Conta de um provider (A2/A4), na mesma forma que o runtime usa em
 * `providerIdentity`: a credencial nomeada, o arquivo OAuth expandido ou o
 * `kind` para provider de plugin. Sem chave, o próprio provider é a conta.
 */
export function providerAccountRefFor(name: string, provider: ProviderConfig): string {
  const credentialRef = providerCredentialRefFor(provider);
  return credentialRef !== undefined && credentialRef.length > 0 ? credentialRef : `provider:${name}`;
}

/**
 * Credencial efetiva do provider para o ledger/lock: nome da env, caminho OAuth
 * expandido ou `kind` do plugin; ausente para provider local sem chave.
 */
export function providerCredentialRefFor(provider: ProviderConfig): string | undefined {
  const raw = provider as { kind: string; credentialRef?: unknown; credentialsPath?: unknown };
  if (raw.kind === "openai-compat") {
    return typeof raw.credentialRef === "string" && raw.credentialRef.length > 0 ? raw.credentialRef : undefined;
  }
  if (raw.kind === "codex-oauth") {
    return typeof raw.credentialsPath === "string" ? expandHome(raw.credentialsPath) : undefined;
  }
  return typeof raw.credentialRef === "string" && raw.credentialRef.length > 0 ? raw.credentialRef : raw.kind;
}

/** Mesma expansão de `~` usada pelo runtime para o caminho de credenciais. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function validateHeaders(value: unknown, field: string): Record<string, string> {
  const raw = expectObject(value, field);
  const headers: Record<string, string> = Object.create(null);
  for (const [name, headerValue] of Object.entries(raw)) {
    if (name.trim().length === 0) {
      fail(`config inválida: "${field}" contém um nome de header vazio`);
    }
    if (isAuthHeader(name)) {
      fail(`config inválida: "${field}.${name}" é header de autenticação; use credentialRef`);
    }
    const text = expectString(headerValue, `${field}.${name}`);
    if (looksLikeSecret(text)) {
      fail(`config inválida: "${field}.${name}" parece conter uma credencial; use credentialRef`);
    }
    headers[name] = text;
  }
  return headers;
}

function validateProvider(name: string, value: unknown): ProviderConfig {
  const field = `providers.${name}`;
  const raw = expectObject(value, field);
  const kind = raw.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    fail(`config inválida: "${field}.kind" deve ser uma string não vazia`);
  }

  const quotaDomain =
    raw.quotaDomain === undefined ? "default" : expectString(raw.quotaDomain, `${field}.quotaDomain`);
  const headers = raw.headers === undefined ? undefined : validateHeaders(raw.headers, `${field}.headers`);
  // C6: campos de fallback — prioridade/retries validados; nomes cruzados depois
  const fallbackFields = {
    ...(raw.name === undefined ? {} : { name: expectString(raw.name, `${field}.name`) }),
    ...(raw.priority === undefined ? {} : { priority: expectPositiveInteger(raw.priority, `${field}.priority`) }),
    ...(raw.fallback === undefined ? {} : { fallback: expectStringArray(raw.fallback, `${field}.fallback`) }),
    ...(raw.maxRetries === undefined ? {} : { maxRetries: expectNonNegativeInteger(raw.maxRetries, `${field}.maxRetries`) }),
    ...(raw.retryBackoffMs === undefined ? {} : { retryBackoffMs: expectPositiveInteger(raw.retryBackoffMs, `${field}.retryBackoffMs`) }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: expectPositiveInteger(raw.timeoutMs, `${field}.timeoutMs`) }),
    ...(raw.streamTimeoutMs === undefined ? {} : { streamTimeoutMs: expectPositiveInteger(raw.streamTimeoutMs, `${field}.streamTimeoutMs`) }),
  };

  if (kind === "openai-compat") {
    const baseUrl = expectString(raw.baseUrl, `${field}.baseUrl`);
    // baseUrl recebe prompts e saída de tools: mesma regra de saída (SSRF/exfiltração).
    const baseUrlIssue = outboundUrlProblem(baseUrl);
    if (baseUrlIssue !== undefined) fail(`config inválida: "${field}.baseUrl" ${baseUrlIssue}`);
    const credentialRef = raw.credentialRef === undefined
      ? undefined
      : expectString(raw.credentialRef, `${field}.credentialRef`);
    // Fontes aceitas (ADR-0019, #311, I-03): env nomeada ou `vault:<credentialId>`.
    // Segredo tem precedência: `AKIA…` também casa `isEnvName` (mesma ordem de
    // `webSearch.apiKeyEnv`). Mensagem nomeia o campo e nunca ecoa o valor.
    if (credentialRef !== undefined && (looksLikeSecret(credentialRef) || (!isEnvName(credentialRef) && !isVaultCredentialRef(credentialRef)))) {
      fail(looksLikeSecret(credentialRef)
        ? `config inválida: "${field}.credentialRef" parece um segredo; use um nome de variável de ambiente ou vault:<credentialId>`
        : `config inválida: "${field}.credentialRef" não é um nome de variável de ambiente nem vault:<credentialId>`);
    }
    return {
      kind,
      baseUrl,
      ...(credentialRef === undefined ? {} : { credentialRef }),
      quotaDomain,
      ...(headers === undefined ? {} : { headers }),
      ...fallbackFields,
    };
  }

  if (kind === "codex-oauth") {
    const baseUrl = raw.baseUrl === undefined ? undefined : expectString(raw.baseUrl, `${field}.baseUrl`);
    if (baseUrl !== undefined) {
      const baseUrlIssue = outboundUrlProblem(baseUrl);
      if (baseUrlIssue !== undefined) fail(`config inválida: "${field}.baseUrl" ${baseUrlIssue}`);
    }
    return {
      kind,
      credentialsPath: expectString(raw.credentialsPath, `${field}.credentialsPath`),
      quotaDomain,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(headers === undefined ? {} : { headers }),
      ...fallbackFields,
    };
  }

  // Kind de plugin (F7-1): shape opaco; a factory é exigida em runtime
  return {
    ...raw,
    kind,
    quotaDomain,
    ...(headers === undefined ? {} : { headers }),
    ...fallbackFields,
  } as PluginProviderConfig;
}

function validateStatus(value: unknown, field: string): ModelStatus {
  if (typeof value !== "string" || !(MODEL_STATUSES as readonly string[]).includes(value)) {
    fail(`config inválida: "${field}" deve ser "active", "deprecated" ou "disabled"`);
  }
  return value as ModelStatus;
}

function validatePrice(value: unknown, field: string): PriceConfig {
  const raw = expectObject(value, field);
  return {
    inputPerM: expectNonNegativeNumber(raw.inputPerM, `${field}.inputPerM`),
    outputPerM: expectNonNegativeNumber(raw.outputPerM, `${field}.outputPerM`),
    fonte: expectString(raw.fonte, `${field}.fonte`),
    verificado: expectBoolean(raw.verificado, `${field}.verificado`),
  };
}

/** Valida `models[*].capabilities` (F-07): vocabulário fechado, valores booleanos. */
function validateCapabilities(value: unknown, field: string): Partial<Record<Capability, boolean>> {
  const raw = expectObject(value, field);
  const result: Partial<Record<Capability, boolean>> = Object.create(null);
  for (const [key, flag] of Object.entries(raw)) {
    if (!isKnownCapability(key)) {
      fail(
        `config inválida: capability "${key}" desconhecida em "${field}" ` +
          `(conhecidas: ${CAPABILITY_KEYS.join(", ")})`,
      );
    }
    result[key as Capability] = expectBoolean(flag, `${field}.${key}`);
  }
  return result;
}

const THINKING_MODES: ReadonlySet<string> = new Set(["toggle", "always", "adaptive", "none"]);
const EFFORT_LEVELS: readonly EffortLevel[] = ["0", "1", "2", "3", "4"];
const CALL_KEYS: ReadonlySet<string> = new Set(["thinking", "effort", "forbidden"]);
const THINKING_KEYS: ReadonlySet<string> = new Set(["mode", "param", "on", "off"]);
const UNSAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Rejeita caminho vazio, chave de protótipo ou raiz de protocolo protegida. */
function validateParamPath(path: string, field: string): void {
  const parts = path.split(".");
  if (parts.some((part) => part.length === 0 || UNSAFE_PATH_SEGMENTS.has(part))) {
    fail(`config inválida: "${field}" contém caminho de parâmetro inválido "${path}"`);
  }
  const root = parts[0]!;
  if ((PROTECTED_FORBIDDEN_ROOTS as readonly string[]).includes(root)) {
    fail(`config inválida: "${field}" não pode apontar para a raiz protegida "${root}"`);
  }
}

/** Valida `models[].call` (D-CFG1): non-discard em todo campo (E1–E8). */
function validateCall(value: unknown, field: string): CallConfig {
  const raw = expectObject(value, field);
  for (const key of Object.keys(raw)) {
    if (!CALL_KEYS.has(key)) fail(`config inválida: "${field}.${key}" desconhecido em call`);
  }

  let thinking: CallConfig["thinking"];
  if (raw.thinking !== undefined) {
    const f = `${field}.thinking`;
    const t = expectObject(raw.thinking, f);
    for (const key of Object.keys(t)) {
      if (!THINKING_KEYS.has(key)) fail(`config inválida: "${f}.${key}" desconhecido em call.thinking`);
    }
    const mode = expectString(t.mode, `${f}.mode`);
    if (!THINKING_MODES.has(mode)) {
      fail(`config inválida: "${f}.mode" deve ser toggle, always, adaptive ou none`);
    }
    const param = expectString(t.param, `${f}.param`);
    validateParamPath(param, `${f}.param`);
    const on = t.on === undefined ? undefined : expectString(t.on, `${f}.on`);
    const off = t.off === undefined ? undefined : expectString(t.off, `${f}.off`);
    if (mode !== "none" && on === undefined) {
      fail(`config inválida: "${f}.on" é obrigatório no modo "${mode}"`);
    }
    if (mode === "toggle" && off === undefined) {
      fail(`config inválida: "${f}.off" é obrigatório no modo "toggle"`);
    }
    if (mode === "none" && (on !== undefined || off !== undefined)) {
      fail(`config inválida: "${f}.on"/"${f}.off" não se aplicam ao modo "none"`);
    }
    if ((mode === "always" || mode === "adaptive") && off !== undefined) {
      fail(`config inválida: "${f}.off" não se aplica ao modo "${mode}"`);
    }
    thinking = {
      mode: mode as ThinkingMode,
      param,
      ...(on === undefined ? {} : { on }),
      ...(off === undefined ? {} : { off }),
    };
  }

  let effort: CallConfig["effort"];
  if (raw.effort !== undefined) {
    const f = `${field}.effort`;
    const e = expectObject(raw.effort, f);
    for (const key of Object.keys(e)) {
      if (key !== "param" && key !== "map") fail(`config inválida: "${f}.${key}" desconhecido em call.effort`);
    }
    const param = expectString(e.param, `${f}.param`);
    validateParamPath(param, `${f}.param`);
    const mapRaw = expectObject(e.map, `${f}.map`);
    for (const key of Object.keys(mapRaw)) {
      if (!(EFFORT_LEVELS as readonly string[]).includes(key)) {
        fail(`config inválida: "${f}.map.${key}" não é um nível de esforço (0..4)`);
      }
    }
    const map = {} as Record<EffortLevel, string>;
    for (const level of EFFORT_LEVELS) {
      map[level] = expectString(mapRaw[level], `${f}.map.${level}`);
    }
    effort = { param, map };
  }

  let forbidden: string[] | undefined;
  if (raw.forbidden !== undefined) {
    if (!Array.isArray(raw.forbidden)) {
      fail(`config inválida: "${field}.forbidden" deve ser uma lista de parâmetros`);
    }
    forbidden = raw.forbidden.map((item: unknown, index: number) => {
      const name = expectString(item, `${field}.forbidden[${index}]`);
      validateParamPath(name, `${field}.forbidden[${index}]`);
      return name;
    });
    const seen = new Set<string>();
    for (const name of forbidden) {
      if (seen.has(name)) fail(`config inválida: "${field}.forbidden" contém "${name}" duplicado`);
      seen.add(name);
    }
  }

  return {
    ...(thinking === undefined ? {} : { thinking }),
    ...(effort === undefined ? {} : { effort }),
    ...(forbidden === undefined ? {} : { forbidden }),
  };
}

function validateModel(value: unknown, index: number): ModelConfig {
  const field = `models[${index}]`;
  const raw = expectObject(value, field);
  const provider = expectString(raw.provider, `${field}.provider`);
  const id = expectString(raw.id, `${field}.id`);
  if (!Array.isArray(raw.tags)) {
    fail(`config inválida: "${field}.tags" deve ser uma lista de tags`);
  }
  const tags = raw.tags.map((tag: unknown, tagIndex: number) => {
    const name = expectString(tag, `${field}.tags[${tagIndex}]`);
    if (!isKnownTag(name)) {
      fail(
        `config inválida: tag "${name}" desconhecida em "${field}.tags" ` +
          `(papel: ${ROLE_TAGS.join(", ")}; capacidade: ${CAPACITY_TAGS.join(", ")})`,
      );
    }
    return name;
  });

  const context = expectPositiveInteger(raw.context, `${field}.context`);
  const status = raw.status === undefined ? "active" : validateStatus(raw.status, `${field}.status`);
  const price = raw.price === undefined ? undefined : validatePrice(raw.price, `${field}.price`);
  const capabilities =
    raw.capabilities === undefined
      ? undefined
      : validateCapabilities(raw.capabilities, `${field}.capabilities`);
  const call = raw.call === undefined ? undefined : validateCall(raw.call, `${field}.call`);
  const efficiency = raw.efficiency === undefined
    ? undefined
    : expectNonNegativeNumber(raw.efficiency, `${field}.efficiency`);
  if (efficiency !== undefined && efficiency > 1) {
    fail(`config inválida: "${field}.efficiency" deve estar entre 0 e 1`);
  }

  return {
    provider,
    id,
    tags,
    context,
    status,
    ...(price === undefined ? {} : { price }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(call === undefined ? {} : { call }),
    ...(efficiency === undefined ? {} : { efficiency }),
  };
}

/**
 * Valida a seção opcional `modelPool` (F-27, ADR-0007): todo profile referencia
 * um modelo `active` de `models[]`; capabilities exigidas são checadas no
 * startup (F-07); `fallback` aponta para profiles existentes (ciclos: F-31).
 */
function validateModelPool(value: unknown, models: ModelConfig[]): Record<string, ProfileConfig> {
  const raw = expectObject(value, "modelPool");
  const result: Record<string, ProfileConfig> = Object.create(null);
  const byKey = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));

  for (const [name, profileRaw] of Object.entries(raw)) {
    if (name.trim().length === 0) fail('config inválida: "modelPool" contém um nome de profile vazio');
    const field = `modelPool.${name}`;
    const p = expectObject(profileRaw, field);
    const model = expectString(p.model, `${field}.model`);
    const entry = byKey.get(model);
    if (entry === undefined) {
      fail(`config inválida: profile "${name}" referencia o modelo "${model}", que não está declarado em "models"`);
    }
    if (entry.status !== "active") {
      fail(`config inválida: profile "${name}" referencia o modelo "${model}" que não está active (status: "${entry.status}")`);
    }

    let capabilities: Capability[] | undefined;
    if (p.capabilities !== undefined) {
      const capsRaw = expectStringArray(p.capabilities, `${field}.capabilities`);
      for (const cap of capsRaw) {
        if (!isKnownCapability(cap)) {
          fail(`config inválida: capability "${cap}" desconhecida em "${field}.capabilities" (conhecidas: ${CAPABILITY_KEYS.join(", ")})`);
        }
      }
      capabilities = capsRaw as Capability[];
      const missing = missingCapabilities(entry, capabilities);
      if (missing.length > 0) {
        fail(`config inválida: profile "${name}" exige capabilities ausentes no modelo "${model}": ${missing.join(", ")}`);
      }
    }

    let fallback: string[] | undefined;
    if (p.fallback !== undefined) {
      fallback = expectStringArray(p.fallback, `${field}.fallback`);
    }

    result[name] = { model, ...(capabilities === undefined ? {} : { capabilities }), ...(fallback === undefined ? {} : { fallback }) };
  }

  for (const [name, profile] of Object.entries(result)) {
    for (const target of profile.fallback ?? []) {
      if (!Object.hasOwn(result, target)) {
        fail(`config inválida: "modelPool.${name}.fallback" aponta para o profile "${target}", que não está declarado em "modelPool"`);
      }
      if (target === name) {
        fail(`config inválida: "modelPool.${name}.fallback" não pode referenciar o próprio profile (autorreferência)`);
      }
    }
  }

  // F-31: a cadeia de profiles precisa ser acíclica (determinismo, I-06).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...stack.slice(stack.indexOf(name)), name].join(" -> ");
      fail(`config inválida: ciclo em "modelPool.*.fallback": ${cycle}`);
    }
    visiting.add(name);
    stack.push(name);
    for (const target of result[name]?.fallback ?? []) visit(target);
    stack.pop();
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(result)) visit(name);

  return result;
}

/** Resolve o profile de um agent (F-27): XOR com `model`; devolve o model resolvido. */
function resolveProfileField(
  field: string,
  raw: Record<string, unknown>,
  modelPool?: Record<string, ProfileConfig>,
): { profile: string; model: string } {
  const profile = expectString(raw.profile, `${field}.profile`);
  if (raw.model !== undefined) {
    fail(`config inválida: "${field}" define "model" e "profile"; use apenas um — o profile substitui o model (ADR-0007)`);
  }
  const entry = modelPool?.[profile];
  if (entry === undefined) {
    fail(`config inválida: "${field}.profile" referencia o profile "${profile}", que não está declarado em "modelPool"`);
  }
  return { profile, model: entry.model };
}

/** Nome que vira segmento do checkpoint (run/agent) é validado no load, não no meio do run (#135). */
function expectCheckpointName(name: string, field: string): string {
  const problem = checkpointIdProblem(name);
  if (problem !== undefined) {
    fail(`config inválida: "${field}" não serve como nome de checkpoint (${problem}); use letras, números, "_", ".", "-", até 120 caracteres, sem separador, dois-pontos, ".." ou controle`);
  }
  return name;
}

function validateAgent(value: unknown, modelPool?: Record<string, ProfileConfig>): AgentConfig {
  const raw = expectObject(value, "agent");
  const systemPrompt =
    raw.systemPrompt === undefined ? undefined : expectString(raw.systemPrompt, "agent.systemPrompt");
  // entryAgent default "planner" (A13, Q-03, pinado em tests/tool-isolation.test.ts)
  const entryAgent = expectCheckpointName(
    raw.entryAgent === undefined ? "planner" : expectString(raw.entryAgent, "agent.entryAgent"),
    "agent.entryAgent",
  );

  // F-27 (ADR-0007): profile substitui model; os dois juntos são ambíguos.
  if (raw.profile !== undefined) {
    const { profile, model } = resolveProfileField("agent", raw, modelPool);
    return {
      model,
      profile,
      maxSteps: raw.maxSteps === undefined ? BASELINE_MAX_STEPS : expectPositiveInteger(raw.maxSteps, "agent.maxSteps"),
      tools: raw.tools === undefined ? [...DEFAULT_AGENT_TOOLS] : expectStringArray(raw.tools, "agent.tools"),
      entryAgent,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    };
  }

  return {
    model: expectString(raw.model, "agent.model"),
    maxSteps: raw.maxSteps === undefined ? BASELINE_MAX_STEPS : expectPositiveInteger(raw.maxSteps, "agent.maxSteps"),
    tools: raw.tools === undefined ? [...DEFAULT_AGENT_TOOLS] : expectStringArray(raw.tools, "agent.tools"),
    entryAgent,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

function validatePaths(value: unknown): PathsConfig {
  if (value === undefined) return { ...DEFAULT_PATHS };
  const raw = expectObject(value, "paths");
  return {
    ledger: expectString(raw.ledger, "paths.ledger"),
    audit: expectString(raw.audit, "paths.audit"),
  };
}

/** Perfil de permissão do agent nomeado (#58); vocabulário fechado. */
function expectAgentPermission(value: unknown, field: string): AgentPermission {
  if (!isAgentPermission(value)) {
    fail(`config inválida: "${field}" deve ser read-only, write, execute ou full`);
  }
  return value;
}

/** Valida `modelRouting` (#58): chaves `provider/id` declaradas, ativas e no mesmo provider do agente. */
function validateModelRouting(
  value: unknown,
  field: string,
  knownModels: Set<string>,
  allModels: ModelConfig[],
  baseModelKey: string,
): ModelRouting {
  const raw = expectObject(value, field);
  const baseProvider = allModels.find((entry) => `${entry.provider}/${entry.id}` === baseModelKey)?.provider;
  for (const key of Object.keys(raw)) {
    if (key !== "cheapModel" && key !== "strongModel") {
      fail(`config inválida: "${field}.${key}" desconhecido`);
    }
  }
  const pick = (key: "cheapModel" | "strongModel"): string | undefined => {
    if (raw[key] === undefined) return undefined;
    const id = expectString(raw[key], `${field}.${key}`);
    if (!knownModels.has(id)) {
      fail(`config inválida: "${field}.${key}" referencia modelo "${id}" não declarado em "models"`);
    }
    const model = allModels.find((entry) => `${entry.provider}/${entry.id}` === id);
    if (model !== undefined && model.status !== "active") {
      fail(`config inválida: "${field}.${key}" referencia modelo "${id}" que não está active (status: "${model.status}")`);
    }
    // I-08/A4: trocar de provider na rota mudaria a conta sem aprovação.
    if (model !== undefined && baseProvider !== undefined && model.provider !== baseProvider) {
      fail(`config inválida: "${field}.${key}" deve usar o provider "${baseProvider}" do agente; troca de conta exige aprovação`);
    }
    return id;
  };
  const cheapModel = pick("cheapModel");
  const strongModel = pick("strongModel");
  if (cheapModel === undefined && strongModel === undefined) {
    fail(`config inválida: "${field}" deve declarar cheapModel e/ou strongModel`);
  }
  return {
    ...(cheapModel === undefined ? {} : { cheapModel }),
    ...(strongModel === undefined ? {} : { strongModel }),
  };
}

/** Valida um agent nomeado (em `agents`). Usa defaults do agent principal se omitido. */
function validateNamedAgent(
  name: string,
  value: unknown,
  baseAgent: AgentConfig,
  knownTools: Set<string>,
  knownModels: Set<string>,
  allModels: ModelConfig[],
  modelPool?: Record<string, ProfileConfig>,
): NamedAgentConfig {
  const field = `agents.${name}`;
  const raw = expectObject(value, field);

  const systemPrompt = raw.systemPrompt === undefined ? undefined : expectString(raw.systemPrompt, `${field}.systemPrompt`);
  const maxSteps = raw.maxSteps === undefined ? baseAgent.maxSteps : expectPositiveInteger(raw.maxSteps, `${field}.maxSteps`);
  const permission = raw.permission === undefined ? undefined : expectAgentPermission(raw.permission, `${field}.permission`);
  let tools = baseAgent.tools;
  if (raw.tools !== undefined) {
    tools = expectStringArray(raw.tools, `${field}.tools`);
    for (const tool of tools) {
      if (!knownTools.has(tool)) {
        fail(`config inválida: agent "${name}" tool "${tool}" desconhecida (disponíveis: ${[...knownTools].join(", ")})`);
      }
    }
  }

  // F-27 (ADR-0007): profile substitui model; os dois juntos são ambíguos.
  if (raw.profile !== undefined) {
    if (raw.modelRouting !== undefined) {
      fail(`config inválida: "${field}" não pode combinar profile com modelRouting`);
    }
    const { profile, model } = resolveProfileField(field, raw, modelPool);
    return {
      model, maxSteps, tools, profile,
      ...(permission === undefined ? {} : { permission }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    };
  }

  const model = raw.model === undefined ? baseAgent.model : expectString(raw.model, `${field}.model`);
  if (!knownModels.has(model)) {
    fail(`config inválida: agent "${name}" referencia modelo "${model}" não declarado em "models"`);
  }
  // Verificar se o modelo está active
  const modelEntry = allModels.find((m) => `${m.provider}/${m.id}` === model);
  if (modelEntry && modelEntry.status !== "active") {
    fail(`config inválida: agent "${name}" referencia modelo "${model}" que não está active (status: "${modelEntry.status}")`);
  }
  const modelRouting = raw.modelRouting === undefined
    ? undefined
    : validateModelRouting(raw.modelRouting, `${field}.modelRouting`, knownModels, allModels, model);

  return {
    model, maxSteps, tools,
    ...(permission === undefined ? {} : { permission }),
    ...(modelRouting === undefined ? {} : { modelRouting }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

/** Valida a seção opcional `cache` (F6-4): defaults 24h/10000 entradas. */
function validateCache(value: unknown): CacheConfig {
  const raw = expectObject(value, "cache");
  const enabled = raw.enabled === undefined ? false : expectBoolean(raw.enabled, "cache.enabled");
  const ttlHours =
    raw.ttlHours === undefined ? 24 : expectNonNegativeNumber(raw.ttlHours, "cache.ttlHours");
  const maxEntries =
    raw.maxEntries === undefined ? 10_000 : expectPositiveInteger(raw.maxEntries, "cache.maxEntries");
  return { enabled, ttlHours, maxEntries };
}

/** Valida a seção opcional `quota` (F6-3): limites por quotaDomain. */
function validateQuota(value: unknown): Record<string, QuotaLimitConfig> {
  const raw = expectObject(value, "quota");
  const result: Record<string, QuotaLimitConfig> = Object.create(null);

  for (const [domain, limitRaw] of Object.entries(raw)) {
    if (domain.trim().length === 0) {
      fail('config inválida: "quota" contém um domínio vazio');
    }
    const field = `quota.${domain}`;
    const limit = expectObject(limitRaw, field);
    const dailyTokens =
      limit.dailyTokens === undefined
        ? undefined
        : expectPositiveInteger(limit.dailyTokens, `${field}.dailyTokens`);
    const monthlyCostUsd =
      limit.monthlyCostUsd === undefined
        ? undefined
        : expectNonNegativeNumber(limit.monthlyCostUsd, `${field}.monthlyCostUsd`);

    if (dailyTokens === undefined && monthlyCostUsd === undefined) {
      fail(`config inválida: "${field}" precisa de dailyTokens ou monthlyCostUsd`);
    }
    result[domain] = {
      ...(dailyTokens === undefined ? {} : { dailyTokens }),
      ...(monthlyCostUsd === undefined ? {} : { monthlyCostUsd }),
    };
  }
  return result;
}

/** Valida a seção opcional `team` (F7-5); chaves desconhecidas falham. */
const TEAM_KEYS: readonly string[] = ["projectBudgetUsd", "sessionBudgetUsd", "weekBudgetUsd", "agentQuotas", "auditWebhook"];

function validateTeam(value: unknown): TeamSectionConfig {
  const raw = expectObject(value, "team");
  for (const key of Object.keys(raw)) {
    if (!TEAM_KEYS.includes(key)) fail(`config inválida: "team.${key}" desconhecido`);
  }
  const result: TeamSectionConfig = Object.create(null);

  if (raw.projectBudgetUsd !== undefined) {
    result.projectBudgetUsd = expectNonNegativeNumber(raw.projectBudgetUsd, "team.projectBudgetUsd");
  }
  if (raw.sessionBudgetUsd !== undefined) {
    result.sessionBudgetUsd = expectNonNegativeNumber(raw.sessionBudgetUsd, "team.sessionBudgetUsd");
  }
  if (raw.weekBudgetUsd !== undefined) {
    result.weekBudgetUsd = expectNonNegativeNumber(raw.weekBudgetUsd, "team.weekBudgetUsd");
  }
  if (raw.auditWebhook !== undefined) {
    const webhook = expectString(raw.auditWebhook, "team.auditWebhook");
    const issue = outboundUrlProblem(webhook);
    if (issue !== undefined) fail(`config inválida: "team.auditWebhook" ${issue}`);
    result.auditWebhook = webhook;
  }
  if (raw.agentQuotas !== undefined) {
    const quotasRaw = expectObject(raw.agentQuotas, "team.agentQuotas");
    const agentQuotas: Record<string, { dailyTokens?: number; monthlyCostUsd?: number }> = Object.create(null);
    for (const [agent, quotaRaw] of Object.entries(quotasRaw)) {
      const field = `team.agentQuotas.${agent}`;
      const quota = expectObject(quotaRaw, field);
      const dailyTokens =
        quota.dailyTokens === undefined
          ? undefined
          : expectPositiveInteger(quota.dailyTokens, `${field}.dailyTokens`);
      const monthlyCostUsd =
        quota.monthlyCostUsd === undefined
          ? undefined
          : expectNonNegativeNumber(quota.monthlyCostUsd, `${field}.monthlyCostUsd`);
      if (dailyTokens === undefined && monthlyCostUsd === undefined) {
        fail(`config inválida: "${field}" precisa de dailyTokens ou monthlyCostUsd`);
      }
      agentQuotas[agent] = {
        ...(dailyTokens === undefined ? {} : { dailyTokens }),
        ...(monthlyCostUsd === undefined ? {} : { monthlyCostUsd }),
      };
    }
    result.agentQuotas = agentQuotas;
  }
  return result;
}

const BUDGET_SCOPES: readonly BudgetScope[] = ["day", "month", "project", "use-as-you-go"];

/** Valida a seção opcional `budget` (B1, D-CFG1) — cada campo é non-discard. */
function validateBudget(value: unknown): BudgetConfig {
  const raw = expectObject(value, "budget");
  const scope = raw.scope;
  if (!BUDGET_SCOPES.includes(scope as BudgetScope)) {
    fail('config inválida: "budget.scope" deve ser day, month, project ou use-as-you-go');
  }
  if (!Object.hasOwn(raw, "limitUsd")) {
    fail('config inválida: "budget.limitUsd" é obrigatório (use null para use-as-you-go)');
  }
  let limitUsd: number | null;
  if (scope === "use-as-you-go") {
    if (raw.limitUsd !== null) fail('config inválida: "budget.limitUsd" deve ser null em scope "use-as-you-go"');
    limitUsd = null;
  } else {
    if (raw.limitUsd === null) fail(`config inválida: "budget.limitUsd" não pode ser null em scope "${scope}"`);
    limitUsd = expectNonNegativeNumber(raw.limitUsd, "budget.limitUsd");
  }
  const warnAt = raw.warnAt === undefined ? 0.8 : expectNonNegativeNumber(raw.warnAt, "budget.warnAt");
  if (warnAt <= 0 || warnAt >= 1) fail('config inválida: "budget.warnAt" deve estar entre 0 e 1 (exclusivo)');
  const onExceed = raw.onExceed === undefined ? "ask" : raw.onExceed;
  if (onExceed !== "ask" && onExceed !== "stop") fail('config inválida: "budget.onExceed" deve ser "ask" ou "stop"');
  const hardCeilingUsd =
    raw.hardCeilingUsd === undefined
      ? undefined
      : expectNonNegativeNumber(raw.hardCeilingUsd, "budget.hardCeilingUsd");
  return {
    scope: scope as BudgetScope,
    limitUsd,
    warnAt,
    onExceed,
    ...(hardCeilingUsd === undefined ? {} : { hardCeilingUsd }),
  };
}

/** Valida a seção opcional `effort` (M5, ADR-0024): off por default e caps fechados. */
function validateEffort(value: unknown): EffortEscalationConfig {
  const raw = expectObject(value, "effort");
  for (const key of Object.keys(raw)) {
    if (!["auto", "autoJumpMax", "maxCumulativeJump"].includes(key)) {
      fail(`config inválida: "effort.${key}" desconhecido`);
    }
  }
  const auto = raw.auto === undefined ? DEFAULT_EFFORT_ESCALATION.auto : expectBoolean(raw.auto, "effort.auto");
  const autoJumpMax = raw.autoJumpMax === undefined
    ? DEFAULT_EFFORT_ESCALATION.autoJumpMax
    : expectPositiveInteger(raw.autoJumpMax, "effort.autoJumpMax");
  if (autoJumpMax > MAX_AUTO_JUMP) {
    fail(`config inválida: "effort.autoJumpMax" deve ser um inteiro entre 1 e ${MAX_AUTO_JUMP}`);
  }
  const maxCumulativeJump = raw.maxCumulativeJump === undefined
    ? DEFAULT_EFFORT_ESCALATION.maxCumulativeJump
    : expectNonNegativeInteger(raw.maxCumulativeJump, "effort.maxCumulativeJump");
  if (maxCumulativeJump > MAX_EFFORT_LEVEL) {
    fail(`config inválida: "effort.maxCumulativeJump" deve ser um inteiro entre 0 e ${MAX_EFFORT_LEVEL}`);
  }
  return { auto, autoJumpMax, maxCumulativeJump };
}

/**
 * Valida `run.tests` (F-15, #538): o comando é argv (item por argumento),
 * nunca uma string de shell, e sem histórico de auto-detecção. Um item único
 * com espaço é a string de shell disfarçada e falha aqui, não no primeiro run.
 */
function validateRunTests(value: unknown): RunTestsConfig {
  const raw = expectObject(value, "run.tests");
  for (const key of Object.keys(raw)) {
    if (key !== "command" && key !== "timeoutMs") {
      fail(`config inválida: "run.tests.${key}" desconhecido (permitidos: "command" e "timeoutMs")`);
    }
  }
  const command = expectStringArray(raw.command, "run.tests.command");
  if (command.length === 0) {
    fail('config inválida: "run.tests.command" precisa do executável (ex.: ["bun", "test"])');
  }
  if (/\s/.test(command[0]!)) {
    fail(
      'config inválida: "run.tests.command" é um argv, não uma string de shell; ' +
        'separe executável e argumentos (ex.: ["bun", "test"], nunca ["bun test"])',
    );
  }
  const timeoutMs = raw.timeoutMs === undefined
    ? DEFAULT_RUN_TESTS_TIMEOUT_MS
    : expectPositiveInteger(raw.timeoutMs, "run.tests.timeoutMs");
  if (timeoutMs > MAX_RUN_TESTS_TIMEOUT_MS) {
    fail(
      `config inválida: "run.tests.timeoutMs" deve ser no máximo ${MAX_RUN_TESTS_TIMEOUT_MS} (1h); ` +
        'acima disso o timer satura e o run falha por timeout em ~1ms',
    );
  }
  return { command, timeoutMs };
}

function validateRunLimit(value: unknown, field: string, choices: readonly number[]): RunLimit {
  if (value === "unlimited") return value;
  if (typeof value === "number" && choices.includes(value)) return value;
  return fail(`config inválida: "${field}" deve ser ${choices.join(" / ")} / unlimited`);
}

interface DerivedRunLimits {
  maxTurns?: RunLimit;
  maxRoundsPerTurn?: RunLimit;
  roundAlias?: boolean;
  legacyGuards: boolean;
}

/** Non-serializable metadata makes validation idempotent without weakening raw input checks. */
const DERIVED_RUN_LIMITS = Symbol("astro.derivedRunLimits");

function derivedRunLimits(value: Record<string, unknown>): DerivedRunLimits | undefined {
  const metadata = (value as Record<symbol, unknown>)[DERIVED_RUN_LIMITS];
  return isPlainObject(metadata) && typeof metadata.legacyGuards === "boolean"
    ? metadata as unknown as DerivedRunLimits
    : undefined;
}

function isDerivedRunLimit(value: Record<string, unknown>, key: "maxTurns" | "maxRoundsPerTurn"): boolean {
  const metadata = derivedRunLimits(value);
  return metadata !== undefined && Object.hasOwn(metadata, key) && metadata[key] === value[key];
}

function withDerivedRunLimits<T extends object>(config: T, metadata: DerivedRunLimits): T {
  Object.defineProperty(config, DERIVED_RUN_LIMITS, { value: metadata });
  return config;
}

/** Preserve per-field provenance when raw and already validated run layers are merged. */
export function mergeDerivedRunLimitMetadata(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  const before = derivedRunLimits(base);
  const after = derivedRunLimits(overlay);
  if (before === undefined && after === undefined) return;
  const metadata: DerivedRunLimits = {
    legacyGuards: (before?.legacyGuards ?? true) || (after?.legacyGuards ?? true),
  };
  for (const key of ["maxTurns", "maxRoundsPerTurn"] as const) {
    const overlayDerived = after !== undefined && Object.hasOwn(after, key) && after[key] === overlay[key];
    const overlayAlias = key === "maxRoundsPerTurn" && overlayDerived && after.roundAlias === true;
    const useBase = Object.hasOwn(base, key) && (!Object.hasOwn(overlay, key) || (overlayDerived && !overlayAlias));
    const source = useBase ? base : overlay;
    if (useBase) merged[key] = base[key];
    const derived = useBase ? before : after;
    if (derived !== undefined && Object.hasOwn(derived, key) && derived[key] === source[key]) {
      metadata[key] = source[key] as RunLimit;
      if (key === "maxRoundsPerTurn" && derived.roundAlias === true) metadata.roundAlias = true;
    }
  }
  withDerivedRunLimits(merged, metadata);
}

/** Canonicalize the declared round alias before layer merging; defaults keep their existing provenance. */
export function canonicalizeRoundAlias(document: Record<string, unknown>): Record<string, unknown> {
  const agent = nestedSection(document, "agent");
  const run = nestedSection(document, "run");
  const rounds = agent?.maxSteps;
  if (typeof rounds !== "number" || (document.run !== undefined && run === undefined) || run?.maxRoundsPerTurn !== undefined) return document;
  const previous = run === undefined ? undefined : derivedRunLimits(run);
  const metadata: DerivedRunLimits = {
    ...previous, maxRoundsPerTurn: rounds, roundAlias: true, legacyGuards: previous?.legacyGuards ?? run !== undefined,
  };
  return { ...document, run: withDerivedRunLimits({ ...run, maxRoundsPerTurn: rounds }, metadata) };
}

/** Validate limits without activating legacy loop guards for an omitted `run` section. */
function validateRun(value: unknown, legacyRounds: number): RunConfig {
  const omitted = value === undefined;
  const raw = omitted ? {} : expectObject(value, "run");
  const previous = derivedRunLimits(raw);
  const turnsDerived = raw.maxTurns === undefined || isDerivedRunLimit(raw, "maxTurns");
  const roundsDerived = raw.maxRoundsPerTurn === undefined || isDerivedRunLimit(raw, "maxRoundsPerTurn");
  const roundAlias = roundsDerived && previous?.roundAlias === true;
  const maxTurns = raw.maxTurns === undefined
    ? 500
    : turnsDerived
      ? raw.maxTurns as RunLimit
      : validateRunLimit(raw.maxTurns, "run.maxTurns", [250, 500, 1000]);
  const maxRoundsPerTurn = raw.maxRoundsPerTurn === undefined
    ? legacyRounds
    : roundsDerived
      ? raw.maxRoundsPerTurn as RunLimit
      : validateRunLimit(raw.maxRoundsPerTurn, "run.maxRoundsPerTurn", [100, 200, 500]);
  const declaresGuard = ["checkpointAt", "noProgressSegments", "judge", "tests"]
    .some((key) => Object.hasOwn(raw, key));
  const legacyGuards = omitted ? false : previous === undefined || previous.legacyGuards || declaresGuard;
  const metadata: DerivedRunLimits = {
    ...(turnsDerived ? { maxTurns } : {}),
    ...(roundsDerived ? { maxRoundsPerTurn } : {}),
    ...(roundAlias ? { roundAlias: true } : {}),
    legacyGuards,
  };
  if (!legacyGuards) return withDerivedRunLimits({ maxTurns, maxRoundsPerTurn }, metadata);

  const checkpointAt = raw.checkpointAt === undefined ? 0.8 : expectNonNegativeNumber(raw.checkpointAt, "run.checkpointAt");
  if (checkpointAt <= 0 || checkpointAt >= 1) {
    fail('config inválida: "run.checkpointAt" deve estar entre 0 e 1 (exclusivo)');
  }
  const noProgressSegments =
    raw.noProgressSegments === undefined ? 3 : expectPositiveInteger(raw.noProgressSegments, "run.noProgressSegments");
  const judge = raw.judge === undefined ? "off" : raw.judge;
  if (!isJudgeMode(judge)) {
    fail('config inválida: "run.judge" deve ser "off", "on" ou "auto"');
  }
  const tests = raw.tests === undefined ? undefined : validateRunTests(raw.tests);
  return withDerivedRunLimits(
    { maxTurns, maxRoundsPerTurn, checkpointAt, noProgressSegments, judge, ...(tests === undefined ? {} : { tests }) },
    metadata,
  );
}

/** Defaults da seção `attachments` (ADR-0026, #392). */
export const DEFAULT_ATTACHMENTS: AttachmentsConfig = Object.freeze({
  image: Object.freeze({ autoResize: false }),
  directory: Object.freeze({ showHidden: false }),
  artifactTtlDays: 7,
  artifactMaxBytes: 1024 ** 3,
});

/** Valida a seção `attachments` (ADR-0026, #392) com vocabulário fechado e defaults. */
function validateAttachments(value: unknown): AttachmentsConfig {
  const raw = value === undefined ? {} : expectObject(value, "attachments");
  for (const key of Object.keys(raw)) {
    if (key !== "image" && key !== "directory" && key !== "artifactTtlDays" && key !== "artifactMaxBytes") {
      fail(`config inválida: "attachments.${key}" desconhecido`);
    }
  }
  const imageRaw = raw.image === undefined ? {} : expectObject(raw.image, "attachments.image");
  for (const key of Object.keys(imageRaw)) {
    if (key !== "autoResize") fail(`config inválida: "attachments.image.${key}" desconhecido`);
  }
  const directoryRaw = raw.directory === undefined ? {} : expectObject(raw.directory, "attachments.directory");
  for (const key of Object.keys(directoryRaw)) {
    if (key !== "showHidden") fail(`config inválida: "attachments.directory.${key}" desconhecido`);
  }
  const autoResize =
    imageRaw.autoResize === undefined
      ? DEFAULT_ATTACHMENTS.image.autoResize
      : expectBoolean(imageRaw.autoResize, "attachments.image.autoResize");
  // Sem dependência de runtime e sem decodificador de imagem, resize não existe:
  // aceitar `true` em silêncio prometeria um comportamento que não acontece.
  if (autoResize) {
    fail('config inválida: "attachments.image.autoResize" não é suportado nesta versão (use false); redimensionamento exige implementação própria e ADR');
  }
  return {
    image: { autoResize },
    directory: {
      showHidden:
        directoryRaw.showHidden === undefined
          ? DEFAULT_ATTACHMENTS.directory.showHidden
          : expectBoolean(directoryRaw.showHidden, "attachments.directory.showHidden"),
    },
    artifactTtlDays:
      raw.artifactTtlDays === undefined
        ? DEFAULT_ATTACHMENTS.artifactTtlDays
        : expectPositiveInteger(raw.artifactTtlDays, "attachments.artifactTtlDays"),
    artifactMaxBytes:
      raw.artifactMaxBytes === undefined
        ? DEFAULT_ATTACHMENTS.artifactMaxBytes
        : expectPositiveInteger(raw.artifactMaxBytes, "attachments.artifactMaxBytes"),
  };
}

/** Valida a seção `handoff` (F-24); ausente aplica o default 30000ms (D-15). */
function validateHandoff(value: unknown): HandoffConfig {
  const raw = value === undefined ? {} : expectObject(value, "handoff");
  return {
    ackTimeoutMs:
      raw.ackTimeoutMs === undefined
        ? DEFAULT_ACK_TIMEOUT_MS
        : expectPositiveInteger(raw.ackTimeoutMs, "handoff.ackTimeoutMs"),
  };
}

/** Valida a seção `spawn` (A11): `parallel` booleano e `maxActive` inteiro positivo (#552); ausente = serial e teto default. */
function validateSpawn(value: unknown): SpawnConfig {
  const raw = expectObject(value, "spawn");
  for (const key of Object.keys(raw)) {
    if (key !== "parallel" && key !== "maxActive") fail(`config inválida: "spawn.${key}" desconhecido`);
  }
  return {
    ...(raw.parallel === undefined ? {} : { parallel: expectBoolean(raw.parallel, "spawn.parallel") }),
    ...(raw.maxActive === undefined ? {} : { maxActive: expectPositiveInteger(raw.maxActive, "spawn.maxActive") }),
  };
}

/** Valida `permissions` (PERM-01); ausente vira `{ mode: "ask" }`. */
function validatePermissions(value: unknown): PermissionsConfig {
  const raw = value === undefined ? {} : expectObject(value, "permissions");
  const mode = raw.mode ?? DEFAULT_PERMISSION_MODE;
  if (!isPermissionMode(mode)) {
    fail('config inválida: "permissions.mode" deve ser bypass, allow-edits ou ask');
  }
  const rawApprovalTimeout = raw.approvalTimeoutMs;
  let approvalTimeoutMs: number | undefined;
  if (rawApprovalTimeout !== undefined) {
    // `0` desliga o teto (#526); fração/negativo/não-número é erro de config.
    if (
      typeof rawApprovalTimeout !== "number" ||
      !Number.isInteger(rawApprovalTimeout) ||
      rawApprovalTimeout < 0
    ) {
      fail('config inválida: "permissions.approvalTimeoutMs" deve ser um inteiro >= 0 em ms (0 desliga)');
    }
    approvalTimeoutMs = rawApprovalTimeout;
  }
  return { mode, ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }) };
}

/**
 * Valida a seção opcional `security` (ADR-0027, #391 slice 3b): vocabulário
 * fechado; `entropyThreshold` deve ser número finito em (0, 8] bits/char —
 * fora disso é `ConfigError` no load (fail-closed, nunca valor frouxo).
 */
function validateSecurity(value: unknown): SecurityConfig {
  const raw = expectObject(value, "security");
  for (const key of Object.keys(raw)) {
    if (key !== "entropyThreshold") fail(`config inválida: "security.${key}" desconhecido`);
  }
  if (raw.entropyThreshold === undefined) return {};
  if (!isValidEntropyThreshold(raw.entropyThreshold)) {
    fail(
      `config inválida: "security.entropyThreshold" deve ser um número finito em (0, ${MAX_ENTROPY_THRESHOLD}] bits/char`,
    );
  }
  return { entropyThreshold: raw.entropyThreshold };
}

export const MCP_TRANSPORTS: readonly MCPServerConfig["transport"][] = ["stdio", "sse", "http"];

/** Valida um registro de strings (env/headers de mcpServers). */
function stringRecord(raw: Record<string, unknown>, field: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val !== "string") fail(`config inválida: "${field}.${key}" deve ser string`);
    out[key] = val;
  }
  return out;
}

/** Headers de MCP: aceita literal não-secreto ou referência `env:NOME` (I-03). */
function mcpHeaders(raw: Record<string, unknown>, field: string): Record<string, string> {
  const headers = stringRecord(raw, field);
  for (const [name, value] of Object.entries(headers)) {
    if (!isValidHeaderName(name)) {
      fail(`config inválida: "${field}.${name}" não é um nome de header válido`);
    }
    if (value.startsWith("env:")) {
      if (headerEnvName(value) === undefined) {
        fail(`config inválida: "${field}.${name}" deve usar "env:NOME_DA_VARIAVEL"`);
      }
      continue;
    }
    if (isAuthHeader(name) || looksLikeSecret(value)) {
      fail(`config inválida: "${field}.${name}" parece conter credencial; use "env:NOME_DA_VARIAVEL"`);
    }
  }
  return headers;
}

/** Valida a seção `mcpServers` (C2, #56); defaults timeoutMs 30000 e enabled true. */
function validateMcpServers(value: unknown): Record<string, MCPServerConfig> {
  const raw = expectObject(value, "mcpServers");
  const result: Record<string, MCPServerConfig> = Object.create(null);
  for (const [name, serverRaw] of Object.entries(raw)) {
    const field = `mcpServers.${name}`;
    if (name.includes("__") || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      fail(`config inválida: "mcpServers.${name}" deve ser um nome com letras, números, "_" ou "-" (sem "__" nem "/")`);
    }
    const raw2 = expectObject(serverRaw, field);
    const transport = raw2.transport;
    if (typeof transport !== "string" || !MCP_TRANSPORTS.includes(transport as MCPServerConfig["transport"])) {
      fail(`config inválida: "${field}.transport" deve ser stdio, sse ou http`);
    }
    const trans = transport as MCPServerConfig["transport"];
    if (raw2.command !== undefined && typeof raw2.command !== "string") {
      fail(`config inválida: "${field}.command" deve ser string`);
    }
    if (trans === "stdio" && (raw2.command === undefined || (raw2.command as string).trim() === "")) {
      fail(`config inválida: "${field}.command" obrigatório para transport stdio`);
    }
    if (trans !== "stdio" && (raw2.url === undefined || typeof raw2.url !== "string")) {
      fail(`config inválida: "${field}.url" obrigatório para transport ${trans}`);
    }
    if (trans !== "stdio") {
      const urlIssue = outboundUrlProblem(raw2.url as string);
      if (urlIssue !== undefined) fail(`config inválida: "${field}.url" ${urlIssue}`);
    }
    let args: string[] = [];
    if (raw2.args !== undefined) {
      if (!Array.isArray(raw2.args) || raw2.args.some((arg) => typeof arg !== "string")) {
        fail(`config inválida: "${field}.args" deve ser uma lista de strings`);
      }
      args = raw2.args as string[];
    }
    const env = raw2.env === undefined ? undefined : stringRecord(expectObject(raw2.env, `${field}.env`), `${field}.env`);
    // I-03 (#496): args e env vão literais para o filho e para o registry; valor
    // em forma de segredo é recusado nomeando só o campo, nunca o valor.
    const secretField = mcpSecretProblem({ [name]: { args, ...(env === undefined ? {} : { env }) } });
    if (secretField !== undefined) {
      fail(`config inválida: "${secretField}" parece conter credencial; remova o valor da config (em headers use "env:NOME")`);
    }
    const headers = raw2.headers === undefined ? undefined : mcpHeaders(expectObject(raw2.headers, `${field}.headers`), `${field}.headers`);
    const timeoutMs = raw2.timeoutMs === undefined ? 30_000 : expectPositiveInteger(raw2.timeoutMs, `${field}.timeoutMs`);
    const retryBackoffMs = raw2.retryBackoffMs === undefined
      ? undefined
      : expectPositiveInteger(raw2.retryBackoffMs, `${field}.retryBackoffMs`);
    const enabled = raw2.enabled === undefined ? true : expectBoolean(raw2.enabled, `${field}.enabled`);
    result[name] = {
      transport: trans,
      ...(raw2.command === undefined ? {} : { command: raw2.command as string }),
      args,
      ...(env === undefined ? {} : { env }),
      ...(raw2.url === undefined ? {} : { url: raw2.url as string }),
      ...(headers === undefined ? {} : { headers }),
      ...(retryBackoffMs === undefined ? {} : { retryBackoffMs }),
      timeoutMs,
      enabled,
    };
  }
  return result;
}

/** Valida a seção opcional `telemetry` (F5-5): off por default, sem PII. */
function validateTelemetry(value: unknown): TelemetryConfig {
  const raw = expectObject(value, "telemetry");
  const enabled = raw.enabled === undefined ? false : expectBoolean(raw.enabled, "telemetry.enabled");
  const endpoint =
    raw.endpoint === undefined
      ? "https://telemetry.astro.local/v1/runs"
      : expectString(raw.endpoint, "telemetry.endpoint");
  const endpointIssue = outboundUrlProblem(endpoint);
  if (endpointIssue !== undefined) fail(`config inválida: "telemetry.endpoint" ${endpointIssue}`);
  let sampleRate = raw.sampleRate === undefined ? 1 : expectNonNegativeNumber(raw.sampleRate, "telemetry.sampleRate");
  if (sampleRate > 1) sampleRate = 1;
  return { enabled, endpoint, sampleRate };
}

/** Valida a seção opcional `tools`. */
function validateTools(value: unknown): ToolsConfig {
  const raw = expectObject(value, "tools");
  const result: ToolsConfig = Object.create(null);

  if (raw.run_command !== undefined) {
    const rcRaw = expectObject(raw.run_command, "tools.run_command");
    // #474: ausente/`"auto"` = auto (Docker quando disponível, senão host);
    // `true`/`"docker"` = Docker; `false` = desligado.
    let sandbox: boolean | "auto" | "docker" | undefined;
    if (rcRaw.sandbox === undefined) sandbox = undefined;
    else if (rcRaw.sandbox === "auto" || rcRaw.sandbox === "docker") sandbox = rcRaw.sandbox;
    else sandbox = expectBoolean(rcRaw.sandbox, "tools.run_command.sandbox");
    result.run_command = sandbox === undefined ? {} : { sandbox };
  }

  return result;
}

/** Validate shell selection and derive `shell.mode` from the legacy sandbox flag in memory. */
function validateShell(value: unknown, legacySandbox?: boolean | "auto" | "docker"): ShellConfig {
  const raw = value === undefined ? {} : expectObject(value, "shell");
  const result: ShellConfig = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (key !== "default" && key !== "mode") fail(`config inválida: "shell.${key}" desconhecido`);
  }
  if (raw.default !== undefined) {
    const shell = expectString(raw.default, "shell.default");
    if (!isHostShell(shell)) {
      fail(`config inválida: "shell.default" deve ser ${HOST_SHELLS.join(", ")} (recebido: "${shell}")`);
    }
    result.default = shell;
  }
  const mode = raw.mode ?? (legacySandbox === undefined ? undefined : legacySandbox === false ? "off" : "host");
  if (mode !== undefined) {
    if (mode !== "host" && mode !== "off") fail('config inválida: "shell.mode" deve ser "host" ou "off"');
    result.mode = mode;
  }
  return result;
}

/**
 * Valida `outputLimit` (S-16, CMP-10): `maxTokens` inteiro positivo e
 * `shareOfWindow` em (0, 1]; cada campo ausente recebe o default.
 */
function validateOutputLimit(value: unknown): OutputLimitConfig {
  if (value === undefined) return { ...DEFAULT_OUTPUT_LIMIT };
  if (!isPlainObject(value)) fail('config inválida: "outputLimit" deve ser um objeto');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "maxTokens" && key !== "shareOfWindow") {
      fail(`config inválida: "outputLimit.${key}" desconhecido`);
    }
  }
  const maxTokens = raw.maxTokens === undefined
    ? DEFAULT_OUTPUT_LIMIT.maxTokens
    : expectPositiveInteger(raw.maxTokens, "outputLimit.maxTokens");
  let shareOfWindow = DEFAULT_OUTPUT_LIMIT.shareOfWindow;
  if (raw.shareOfWindow !== undefined) {
    const share = raw.shareOfWindow;
    if (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share > 1) {
      fail('config inválida: "outputLimit.shareOfWindow" deve ser um número em (0, 1]');
    }
    shareOfWindow = share;
  }
  return { maxTokens, shareOfWindow };
}

/**
 * Valida `compaction` (S-17, CMP-1): `buffer` inteiro >= 0 ou null (default).
 */
function validateCompaction(value: unknown): CompactionConfig {
  if (value === undefined) return { ...DEFAULT_COMPACTION_CONFIG };
  if (!isPlainObject(value)) fail('config inválida: "compaction" deve ser um objeto');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "buffer") fail(`config inválida: "compaction.${key}" desconhecido`);
  }
  if (raw.buffer === undefined || raw.buffer === null) return { buffer: null };
  const buffer = raw.buffer;
  if (typeof buffer !== "number" || !Number.isInteger(buffer) || buffer < 0) {
    fail('config inválida: "compaction.buffer" deve ser inteiro >= 0 ou null');
  }
  return { buffer };
}

/**
 * Memória (#532): `memory.maxChars` inteiro positivo; ausente mantém o default
 * do loader (DEFAULT_MEMORY_MAX_CHARS), então a config não congela o número.
 */
function validateMemory(value: unknown): MemoryConfig {
  if (!isPlainObject(value)) fail('config inválida: "memory" deve ser um objeto');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "maxChars") fail(`config inválida: "memory.${key}" desconhecido`);
  }
  const maxChars = raw.maxChars === undefined
    ? DEFAULT_MEMORY_MAX_CHARS
    : expectPositiveInteger(raw.maxChars, "memory.maxChars");
  if (maxChars < MIN_MEMORY_MAX_CHARS) {
    fail(`config inválida: "memory.maxChars" deve ser >= ${MIN_MEMORY_MAX_CHARS} (recebido: ${maxChars})`);
  }
  return { maxChars };
}
/**
 * Valida `webSearch` (#57): a chave é sempre um NOME de variável de ambiente
 * (I-03); `custom` exige baseUrl. Default de resultados 5, teto 10.
 */
function validateWebSearch(value: unknown): WebSearchConfig {
  const raw = expectObject(value, "webSearch");
  const known = new Set(["provider", "apiKeyEnv", "baseUrl", "defaultMaxResults"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) fail(`config inválida: "webSearch.${key}" desconhecido`);
  }
  const providers: readonly WebSearchProvider[] = ["exa", "brave", "google", "custom"];
  const provider = raw.provider;
  if (typeof provider !== "string" || !providers.includes(provider as WebSearchProvider)) {
    fail('config inválida: "webSearch.provider" deve ser exa, brave, google ou custom');
  }
  const apiKeyEnv = expectString(raw.apiKeyEnv, "webSearch.apiKeyEnv");
  if (!isEnvName(apiKeyEnv) || looksLikeSecret(apiKeyEnv)) {
    fail('config inválida: "webSearch.apiKeyEnv" deve ser o NOME de uma variável de ambiente; nunca o valor da chave (I-03)');
  }
  const baseUrl = raw.baseUrl === undefined ? undefined : expectString(raw.baseUrl, "webSearch.baseUrl");
  if (baseUrl !== undefined) {
    const problem = urlProblem(baseUrl);
    if (problem !== undefined) fail(`config inválida: "webSearch.baseUrl" ${problem}`);
  }
  if (provider === "custom" && baseUrl === undefined) {
    fail('config inválida: "webSearch.baseUrl" é obrigatório para o provider "custom"');
  }
  let defaultMaxResults: number | undefined;
  if (raw.defaultMaxResults !== undefined) {
    defaultMaxResults = expectPositiveInteger(raw.defaultMaxResults, "webSearch.defaultMaxResults");
    if (defaultMaxResults > 10) {
      fail('config inválida: "webSearch.defaultMaxResults" deve ser no máximo 10');
    }
  }
  return {
    provider: provider as WebSearchProvider,
    apiKeyEnv,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(defaultMaxResults === undefined ? {} : { defaultMaxResults }),
  };
}

/**
 * Versão do schema do documento de config (ADR-0028), independente da versão do
 * harness em `package.json`: major remove/renomeia/redefine (ou endurece a
 * validação), minor soma chave opcional retrocompatível, patch só corrige
 * mensagem. O alvo hoje é o major 1.
 */
export const CONFIG_SCHEMA_VERSION = "2.0.0";

const CONFIG_SCHEMA_MAJOR = Number(CONFIG_SCHEMA_VERSION.split(".")[0]);

/**
 * Chaves de topo conhecidas por major (ADR-0028), fonte runtime de "chave
 * conhecida". O major 1 não remove nem renomeia chave de topo — endurece a
 * validação das seções de forma fixa —, então o conjunto é o mesmo do legado.
 * `activeProfileId` só existe na camada global (`$ASTRO_HOME/config.json`,
 * #459/#492); `$schema` e `provenance` são metadados, nunca config.
 * `migratedFrom` é derivado por `validateConfig` (ADR-0028): aceito de volta
 * quando uma config já validada entra como camada, e nunca lido como ajuste.
 */
const CONFIG_KEYS_V1: readonly string[] = [
  "$schema", "provenance", "activeProfileId", "migratedFrom",
  "preset", "providers", "models", "modelPool", "agent", "agents", "maxActive",
  "tools", "shell", "telemetry", "quota", "budget", "run", "attachments", "cache",
  "plugins", "version", "team", "handoff", "spawn", "permissions", "security",
  "effort", "pricing", "mcpServers", "outputLimit", "compaction", "webSearch",
  "memory", "paths",
];

export const CONFIG_KEYS: Readonly<Record<number, readonly string[]>> = Object.freeze({
  0: CONFIG_KEYS_V1,
  1: CONFIG_KEYS_V1,
  2: CONFIG_KEYS_V1,
});

/** Forma de uma seção para a checagem de chave desconhecida (ADR-0028). */
interface ConfigShape {
  /** Chaves de objeto de forma fixa; ausente = contêiner de nome livre. */
  keys?: readonly string[];
  /** Chaves resolvidas pelo conteúdo (provider varia com `kind`); undefined = forma opaca. */
  keysFor?: (value: Record<string, unknown>) => readonly string[] | undefined;
  /** Forma dos valores de um contêiner de nome livre. */
  values?: ConfigShape;
  /** Forma de cada item de uma lista. */
  items?: ConfigShape;
  children?: Record<string, ConfigShape>;
}

const OPAQUE_SHAPE: ConfigShape = {};
const FREE_STRING_MAP: ConfigShape = { values: OPAQUE_SHAPE };

const PRICE_KEYS: readonly string[] = ["inputPerM", "outputPerM", "fonte", "verificado"];
const QUOTA_KEYS: readonly string[] = ["dailyTokens", "monthlyCostUsd"];
const PROVIDER_COMMON_KEYS: readonly string[] = [
  "kind", "name", "quotaDomain", "headers", "priority", "fallback",
  "maxRetries", "retryBackoffMs", "timeoutMs", "streamTimeoutMs",
];
const OPENAI_PROVIDER_KEYS: readonly string[] = [...PROVIDER_COMMON_KEYS, "baseUrl", "credentialRef"];
const CODEX_PROVIDER_KEYS: readonly string[] = [...PROVIDER_COMMON_KEYS, "credentialsPath", "baseUrl"];
const NAMED_AGENT_KEYS: readonly string[] = [
  "model", "maxSteps", "tools", "systemPrompt", "profile", "permission", "modelRouting",
];

/** Forma do documento no major 1: só as seções de forma fixa são inspecionadas. */
const CONFIG_SHAPE: ConfigShape = {
  keys: CONFIG_KEYS_V1,
  children: {
    providers: {
      values: {
        keysFor: (value) =>
          value.kind === "openai-compat"
            ? OPENAI_PROVIDER_KEYS
            : value.kind === "codex-oauth"
              ? CODEX_PROVIDER_KEYS
              : undefined,
        children: { headers: FREE_STRING_MAP },
      },
    },
    models: {
      items: {
        keys: ["provider", "id", "tags", "context", "status", "price", "capabilities", "call", "efficiency"],
        children: {
          price: { keys: PRICE_KEYS },
          capabilities: FREE_STRING_MAP,
          call: {
            keys: [...CALL_KEYS],
            children: {
              thinking: { keys: [...THINKING_KEYS] },
              effort: { keys: ["param", "map"], children: { map: FREE_STRING_MAP } },
            },
          },
        },
      },
    },
    modelPool: { values: { keys: ["model", "capabilities", "fallback"] } },
    agent: { keys: ["model", "maxSteps", "tools", "systemPrompt", "entryAgent", "profile"] },
    agents: {
      values: { keys: NAMED_AGENT_KEYS, children: { modelRouting: { keys: ["cheapModel", "strongModel"] } } },
    },
    tools: { keys: ["run_command"], children: { run_command: { keys: ["sandbox"] } } },
    shell: { keys: ["default", "mode"] },
    telemetry: { keys: ["enabled", "endpoint", "sampleRate"] },
    quota: { values: { keys: QUOTA_KEYS } },
    budget: { keys: ["scope", "limitUsd", "warnAt", "onExceed", "hardCeilingUsd"] },
    run: {
      // `maxTurns` é chave removida no P4: `validateRun` responde com a migração
      // para `agent.maxSteps` (não é typo, então não vira config_unknown_key).
      keys: ["checkpointAt", "noProgressSegments", "judge", "tests", "maxTurns", "maxRoundsPerTurn"],
      children: { tests: { keys: ["command", "timeoutMs"] } },
    },
    attachments: {
      keys: ["image", "directory", "artifactTtlDays", "artifactMaxBytes"],
      children: { image: { keys: ["autoResize"] }, directory: { keys: ["showHidden"] } },
    },
    cache: { keys: ["enabled", "ttlHours", "maxEntries"] },
    team: { keys: TEAM_KEYS, children: { agentQuotas: { values: { keys: QUOTA_KEYS } } } },
    handoff: { keys: ["ackTimeoutMs"] },
    spawn: { keys: ["parallel", "maxActive"] },
    permissions: { keys: ["mode", "approvalTimeoutMs"] },
    security: { keys: ["entropyThreshold"] },
    effort: { keys: ["auto", "autoJumpMax", "maxCumulativeJump"] },
    pricing: { values: { keys: PRICE_KEYS } },
    mcpServers: {
      values: {
        keys: ["transport", "command", "args", "env", "url", "headers", "retryBackoffMs", "timeoutMs", "enabled"],
        children: { env: FREE_STRING_MAP, headers: FREE_STRING_MAP },
      },
    },
    outputLimit: { keys: ["maxTokens", "shareOfWindow"] },
    compaction: { keys: ["buffer"] },
    webSearch: { keys: ["provider", "apiKeyEnv", "baseUrl", "defaultMaxResults"] },
    memory: { keys: ["maxChars"] },
    paths: { keys: ["ledger", "audit"] },
    provenance: { keys: ["registry", "plugins"] },
  },
};

interface ParsedConfigVersion {
  text: string;
  major: number;
  minor: number;
  patch: number;
}

const CONFIG_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function configLabel(source: string | undefined): string {
  return source === undefined ? "config" : `configuração em "${source}"`;
}

/** Forma de `version` (ADR-0028 passo 1); o valor cru nunca aparece na mensagem (I-03). */
function parseConfigVersion(
  document: Record<string, unknown>,
  source: string | undefined,
): ParsedConfigVersion | undefined {
  const value = document.version;
  if (value === undefined) return undefined;
  const match = typeof value === "string" ? CONFIG_VERSION_PATTERN.exec(value) : null;
  if (match === null) {
    throw new ConfigError(
      `${configLabel(source)}: "version" deve ser semver x.y.z (formato esperado: ${CONFIG_SCHEMA_VERSION}) — nada foi alterado`,
      "config_invalid_schema",
    );
  }
  return {
    text: value as string,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function collectUnknownKeys(value: unknown, shape: ConfigShape, field: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    const items = shape.items;
    if (items === undefined) return;
    value.forEach((item, index) => collectUnknownKeys(item, items, `${field}[${index}]`, out));
    return;
  }
  if (!isPlainObject(value)) return;
  const values = shape.values;
  if (values !== undefined) {
    for (const [name, item] of Object.entries(value)) {
      collectUnknownKeys(item, values, field === "" ? name : `${field}.${name}`, out);
    }
    return;
  }
  const keys = shape.keysFor === undefined ? shape.keys : shape.keysFor(value);
  // Forma opaca (provider de plugin): o conteúdo é do plugin, não do schema.
  if (keys === undefined) return;
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) out.add(field === "" ? key : `${field}.${key}`);
  }
  for (const [name, child] of Object.entries(shape.children ?? {})) {
    const item = value[name];
    if (item !== undefined) collectUnknownKeys(item, child, field === "" ? name : `${field}.${name}`, out);
  }
}

/** União `CONFIG_KEYS(0..major)`: uma config legada usa o conjunto legado inteiro. */
function topLevelKeysThrough(major: number): readonly string[] {
  const keys = new Set<string>();
  for (let step = 0; step <= major; step += 1) {
    for (const key of CONFIG_KEYS[step] ?? []) keys.add(key);
  }
  return [...keys];
}

function assertKnownConfigKeys(
  document: Record<string, unknown>,
  options: {
    source?: string;
    topLevelKeys: readonly string[];
    strictSections: boolean;
    minorAhead: boolean;
  },
): void {
  const problems = new Set<string>();
  const allowed = new Set(options.topLevelKeys);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) problems.add(key);
  }
  if (options.strictSections) collectUnknownKeys(document, CONFIG_SHAPE, "", problems);
  const first = [...problems][0];
  if (first === undefined) return;
  const hint = options.minorAhead ? " e o arquivo declara um minor mais novo que este harness" : "";
  throw new ConfigError(
    `${configLabel(options.source)}: chave desconhecida "${first}" (major ${CONFIG_SCHEMA_MAJOR} de destino${hint}) — ` +
      'se a config veio de outra versão, rode "astro config migrate"; nada foi alterado',
    "config_unknown_key",
  );
}

/** `$schema` e `provenance` são metadados validados, nunca config nem autorização. */
function validateConfigMetadata(document: Record<string, unknown>, source: string | undefined): void {
  if (document.$schema !== undefined) {
    const value = document.$schema;
    if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:/i.test(value.trim())) {
      throw new ConfigError(
        `${configLabel(source)}: "$schema" deve ser uma URI em string — nada foi alterado`,
        "config_invalid_schema",
      );
    }
  }
  if (document.provenance !== undefined) {
    const provenance = document.provenance;
    if (
      !isPlainObject(provenance) ||
      typeof provenance.registry !== "string" ||
      provenance.registry.trim() === "" ||
      typeof provenance.plugins !== "boolean"
    ) {
      throw new ConfigError(
        `${configLabel(source)}: "provenance" deve ser {registry: string, plugins: boolean} — nada foi alterado`,
        "config_invalid_schema",
      );
    }
  }
}

const PERMISSION_MODE_RANK: Readonly<Record<string, number>> = { ask: 0, "allow-edits": 1, bypass: 2 };
/** Modo desconhecido (ou de tipo errado) conta como o mais permissivo: fail-closed. */
const MOST_PERMISSIVE_MODE_RANK = 2;

function nestedSection(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return isPlainObject(current) ? current : undefined;
}

function stringSet(value: unknown): Set<string> | undefined {
  return Array.isArray(value)
    ? new Set(value.filter((item): item is string => typeof item === "string"))
    : undefined;
}

/** Rank de permissividade: maior = mais permissivo; desconhecido = 2. */
function permissionModeRank(mode: unknown): number {
  if (typeof mode !== "string") return MOST_PERMISSIVE_MODE_RANK;
  return PERMISSION_MODE_RANK[mode] ?? MOST_PERMISSIVE_MODE_RANK;
}

/**
 * Allowlist efetiva de tools (I-01/D-07): `agent.tools` omitido significa as 6
 * tools default, não "sem tools"; agent nomeado sem `tools` herda do principal.
 */
function effectiveToolAllowlist(source: Record<string, unknown>, agentName?: string): Set<string> {
  const base = stringSet(nestedSection(source, "agent")?.tools) ?? new Set(DEFAULT_AGENT_TOOLS);
  if (agentName === undefined) return base;
  return stringSet(nestedSection(source, "agents", agentName)?.tools) ?? base;
}

/**
 * Conteúdo que aparece no destino sem existir na origem: chave nova em qualquer
 * nível (inclusive dentro de contêiner de nome livre, como `mcpServers.evil`) e
 * item novo em lista (`tools`, `providers`, `modelPool`, `plugins`). Migração
 * transforma o que existe; `version` é a única adição permitida (o carimbo).
 */
function addedContentProblem(before: unknown, after: unknown, field: string): string | undefined {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(after)) {
      if (field === "" && key === "version") continue;
      const path = field === "" ? key : `${field}.${key}`;
      if (!Object.hasOwn(before, key)) return path;
      const nested = addedContentProblem(before[key], after[key], path);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (after.length > before.length) return field;
    for (let index = 0; index < after.length; index += 1) {
      const nested = addedContentProblem(before[index], after[index], `${field}[${index}]`);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Problema de segurança introduzido por um passo de migração: a chave citada
 * ficaria mais permissiva ou teria sido injetada (ADR-0028). Chave ausente conta
 * como default, então o guard é fail-closed. Exportado para o teste de tabela
 * (não é API de runtime).
 */
export function migrationSecurityProblem(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string | undefined {
  const added = addedContentProblem(before, after, "");
  if (added !== undefined) return added;

  // `permissions.mode`: só endurecer. `bypass`/desconhecido é o topo do rank.
  const beforeMode = nestedSection(before, "permissions")?.mode ?? "ask";
  const afterMode = nestedSection(after, "permissions")?.mode ?? "ask";
  if (permissionModeRank(afterMode) > permissionModeRank(beforeMode)) return "permissions.mode";

  // `tools.run_command.sandbox` ausente = true (fail-closed).
  const beforeSandbox = nestedSection(before, "tools", "run_command")?.sandbox;
  const afterSandbox = nestedSection(after, "tools", "run_command")?.sandbox;
  if (afterSandbox === false && beforeSandbox !== false) return "tools.run_command.sandbox";

  const beforeBudget = nestedSection(before, "budget");
  const afterBudget = nestedSection(after, "budget");
  if (beforeBudget !== undefined) {
    if (afterBudget === undefined) return "budget";
    const beforeLimit = beforeBudget.limitUsd;
    const afterLimit = afterBudget.limitUsd;
    if (typeof beforeLimit === "number" && (typeof afterLimit !== "number" || afterLimit > beforeLimit)) {
      return "budget.limitUsd";
    }
    const beforeCeiling = beforeBudget.hardCeilingUsd;
    const afterCeiling = afterBudget.hardCeilingUsd;
    if (typeof beforeCeiling === "number" && (typeof afterCeiling !== "number" || afterCeiling > beforeCeiling)) {
      return "budget.hardCeilingUsd";
    }
    if (beforeBudget.onExceed === "stop" && afterBudget.onExceed !== "stop") return "budget.onExceed";
    const beforeWarnAt = beforeBudget.warnAt;
    const afterWarnAt = afterBudget.warnAt;
    if (typeof beforeWarnAt === "number" && typeof afterWarnAt === "number" && afterWarnAt < beforeWarnAt) {
      return "budget.warnAt";
    }
  }

  const beforePaths = nestedSection(before, "paths");
  if (beforePaths !== undefined && JSON.stringify(beforePaths) !== JSON.stringify(nestedSection(after, "paths"))) {
    return "paths";
  }

  // Entropia maior = menos conteúdo barrado (ADR-0027).
  const beforeEntropy = nestedSection(before, "security")?.entropyThreshold;
  const afterEntropy = nestedSection(after, "security")?.entropyThreshold;
  if (typeof beforeEntropy === "number" && (typeof afterEntropy !== "number" || afterEntropy > beforeEntropy)) {
    return "security.entropyThreshold";
  }

  // Allowlist de tools nunca cresce (I-01), inclusive quando a origem omite a
  // chave e o default de seis tools entra em vigor.
  const beforeTools = effectiveToolAllowlist(before);
  const afterTools = effectiveToolAllowlist(after);
  if ([...afterTools].some((tool) => !beforeTools.has(tool))) return "agent.tools";
  for (const name of Object.keys(nestedSection(after, "agents") ?? {})) {
    const beforeAgentTools = effectiveToolAllowlist(before, name);
    const afterAgentTools = effectiveToolAllowlist(after, name);
    if ([...afterAgentTools].some((tool) => !beforeAgentTools.has(tool))) return `agents.${name}.tools`;
  }
  return undefined;
}

export type ConfigMigrationStep = (document: Record<string, unknown>, source?: string) => Record<string, unknown>;

/**
 * Major 0 -> 1: o major 1 só endurece a validação das seções de forma fixa, sem
 * remover nem renomear chave. O passo preserva o documento inteiro (inclusive
 * `$schema`, `provenance` e nomes livres) e é a base da cadeia `VnToN+1`.
 */
function migrateV0ToV1(document: Record<string, unknown>): Record<string, unknown> {
  return document;
}

/** Schema 1 maxTurns meant rounds; schema 2 reuses the name for turns, so confirmation is mandatory. */
function migrateV1ToV2(document: Record<string, unknown>, source?: string): Record<string, unknown> {
  const run = nestedSection(document, "run");
  if (run !== undefined && Object.hasOwn(run, "maxTurns") && !isDerivedRunLimit(run, "maxTurns")) {
    throw new ConfigError(
      `${configLabel(source)}: "run.maxTurns" meant model/tool rounds in schema 1.x but means chat turns in schema 2.0.0; ` +
        'confirm the new meaning and set version: "2.0.0" explicitly — nothing was changed',
      "config_migration_required",
    );
  }
  return document;
}

/** Passo puro `n -> n+1`; falta de passo é `config_migration_required`, nunca adivinha. */
const CONFIG_MIGRATIONS: Readonly<Record<number, ConfigMigrationStep>> = Object.freeze({
  0: migrateV0ToV1,
  1: migrateV1ToV2,
});

/**
 * Roda a cadeia de passos puros por major, recusando qualquer passo que afrouxe
 * chave de segurança ou acrescente conteúdo (ADR-0028). Exportado para permitir
 * testar a recusa com uma tabela injetada.
 */
export function runConfigMigrations(
  document: Record<string, unknown>,
  fromMajor: number,
  steps: Readonly<Record<number, ConfigMigrationStep>>,
  source?: string,
): Record<string, unknown> {
  let current = document;
  for (let major = fromMajor; major < CONFIG_SCHEMA_MAJOR; major += 1) {
    const step = steps[major];
    if (step === undefined) {
      throw new ConfigError(
        `${configLabel(source)}: não há migração do major ${major} para ${major + 1} rumo ao major ` +
          `${CONFIG_SCHEMA_MAJOR} — nada foi alterado`,
        "config_migration_required",
      );
    }
    const next = step(current, source);
    const problem = migrationSecurityProblem(current, next);
    if (problem !== undefined) {
      throw new ConfigError(
        `${configLabel(source)}: a migração ${major}->${major + 1} reduziria a chave de segurança "${problem}"; ` +
          "recusada — nada foi alterado",
        "config_migration_required",
      );
    }
    current = next;
  }
  return current;
}

function migrateToSupported(
  document: Record<string, unknown>,
  fromMajor: number,
  source: string | undefined,
): Record<string, unknown> {
  return runConfigMigrations(document, fromMajor, CONFIG_MIGRATIONS, source);
}

export interface ConfigDocumentMeta {
  /** Documento migrado em memória para o major suportado (sem carimbar `version`). */
  document: Record<string, unknown>;
  /** `version` declarado; `"0.0.0"` quando ausente (legado). */
  declaredVersion: string;
  versionDeclared: boolean;
  targetVersion: string;
  /** `true` quando o major declarado é anterior ao suportado. */
  migrated: boolean;
  minorAheadOfSupported: boolean;
}

/**
 * Ordem normativa do ADR-0028: (1) forma de `version`; (2) major à frente falha
 * **antes** de qualquer checagem de chave; (3) chave desconhecida no documento
 * de origem; (4) migração em memória, um major por passo; (5) destino contra o
 * major suportado. Passo (6), a validação do resultado, é de `validateConfig`.
 * Puro: nunca grava.
 */
export function inspectConfigDocument(
  raw: Record<string, unknown>,
  options: { source?: string } = {},
): ConfigDocumentMeta {
  const source = options.source;
  const declared = parseConfigVersion(raw, source);
  if (declared !== undefined && declared.major > CONFIG_SCHEMA_MAJOR) {
    throw new ConfigError(
      `${configLabel(source)} declara schema ${declared.text}, mas este harness suporta até ` +
        `${CONFIG_SCHEMA_VERSION} (major ${CONFIG_SCHEMA_MAJOR}) — atualize o harness; nada foi alterado`,
      "config_ahead_of_harness",
    );
  }
  const declaredMajor = declared?.major ?? 0;
  const declaredMinor = declared?.minor ?? 0;
  const supportedMinor = Number(CONFIG_SCHEMA_VERSION.split(".")[1]);
  assertKnownConfigKeys(raw, {
    ...(source === undefined ? {} : { source }),
    // ADR-0028: união `CONFIG_KEYS(declarado..suportado)`; sem `version`, `0..suportado`.
    topLevelKeys: topLevelKeysThrough(CONFIG_SCHEMA_MAJOR),
    strictSections: declaredMajor >= 1,
    minorAhead: false,
  });
  const document = migrateToSupported(raw, declaredMajor, source);
  // Major igual e minor maior: a chave desconhecida ganha dica de upgrade, mas
  // continua erro — a dica nunca suprime typo.
  const minorAhead = declaredMajor === CONFIG_SCHEMA_MAJOR && declaredMinor > supportedMinor;
  assertKnownConfigKeys(document, {
    ...(source === undefined ? {} : { source }),
    topLevelKeys: CONFIG_KEYS[CONFIG_SCHEMA_MAJOR] ?? [],
    strictSections: true,
    minorAhead,
  });
  validateConfigMetadata(document, source);
  return {
    document,
    declaredVersion: declared?.text ?? "0.0.0",
    versionDeclared: declared !== undefined,
    targetVersion: CONFIG_SCHEMA_VERSION,
    migrated: declaredMajor < CONFIG_SCHEMA_MAJOR,
    minorAheadOfSupported: minorAhead,
  };
}

/**
 * Migração em memória (o default do ADR-0028, sem escrita). Carimba `version`
 * só quando há mudança de major; um arquivo já no major suportado devolve
 * `changed: false` e nunca é reescrito.
 */
export function migrateConfigInMemory(
  raw: Record<string, unknown>,
  options: { source?: string } = {},
): ConfigDocumentMeta & { changed: boolean } {
  const meta = inspectConfigDocument(raw, options);
  if (!meta.migrated) return { ...meta, changed: false };
  // `version` carimbado por último: a versão antiga do documento não vence.
  return { ...meta, document: { ...meta.document, version: CONFIG_SCHEMA_VERSION }, changed: true };
}

/**
 * Valida a configuração crua (tipicamente vinda de JSON) e aplica os defaults:
 * `status: "active"` por modelo e `quotaDomain: "default"` por provider.
 * `source` é o arquivo de origem, citado nas recusas de schema (ADR-0028).
 */
export function validateConfig(raw: unknown, options: { source?: string } = {}): AstroConfig {
  const input = expectObject(raw, "config");
  const meta = inspectConfigDocument(input, options);
  const checked = canonicalizeRoundAlias(meta.document);
  const preset = validatePreset(checked.preset);
  // #515: simple fixa os limites antes da validação normal; control ganha 500
  // turnos quando não declara nenhum.
  const root = preset === "control" ? checked : applySimplePreset(checked);

  const providersRaw = expectObject(root.providers, "providers");
  const providers: Record<string, ProviderConfig> = Object.create(null);
  for (const [name, providerRaw] of Object.entries(providersRaw)) {
    providers[name] = validateProvider(name, providerRaw);
  }

  if (!Array.isArray(root.models)) {
    fail('config inválida: "models" deve ser uma lista de modelos');
  }
  const models = root.models.map((modelRaw: unknown, index: number) => validateModel(modelRaw, index));

  const seenModels = new Set<string>();
  for (const model of models) {
    if (!Object.hasOwn(providers, model.provider)) {
      fail(
        `config inválida: modelo "${model.provider}/${model.id}" aponta para o provider ` +
          `"${model.provider}", que não está declarado em "providers"`,
      );
    }
    const key = `${model.provider}/${model.id}`;
    if (seenModels.has(key)) {
      fail(`config inválida: modelo duplicado "${key}" em "models"`);
    }
    seenModels.add(key);
  }

  // C6: cadeia de fallback referencia providers declarados
  for (const [name, provider] of Object.entries(providers)) {
    for (const target of provider.fallback ?? []) {
      if (!Object.hasOwn(providers, target)) {
        fail(`config inválida: "providers.${name}.fallback" aponta para o provider "${target}", que não está declarado`);
      }
    }
  }

  // C6: tabela de preços global — key `provider/model-id` de modelo declarado
  let pricing: Record<string, PriceConfig> | undefined;
  if (root.pricing !== undefined) {
    const pricingRaw = expectObject(root.pricing, "pricing");
    const table: Record<string, PriceConfig> = Object.create(null);
    for (const [key, priceRaw] of Object.entries(pricingRaw)) {
      if (!seenModels.has(key)) {
        fail(`config inválida: "pricing.${key}" não corresponde a um modelo declarado em "models"`);
      }
      table[key] = validatePrice(priceRaw, `pricing.${key}`);
    }
    pricing = table;
  }

  // Model pool (F-27, ADR-0007): profiles resolvem para modelos de models[]
  const modelPool =
    root.modelPool === undefined ? undefined : validateModelPool(root.modelPool, models);

  const agent = validateAgent(root.agent, modelPool);
  if (!seenModels.has(agent.model)) {
    fail(
      `config inválida: "agent.model" referencia o modelo "${agent.model}", ` +
        `que não está declarado em "models"`,
    );
  }

  // Validar agents nomeados (F3-1). `maxActive` é reservado (A2): não é agente.
  const agents: Record<string, NamedAgentConfig> = Object.create(null);
  let maxActive: number | undefined;
  if (root.agents !== undefined) {
    const agentsRaw = expectObject(root.agents, "agents");
    const knownTools = new Set(agent.tools);
    for (const [name, agentRaw] of Object.entries(agentsRaw)) {
      if (name === "maxActive") {
        maxActive = expectPositiveInteger(agentRaw, "agents.maxActive");
        continue;
      }
      expectCheckpointName(name, `agents.${name}`);
      agents[name] = validateNamedAgent(name, agentRaw, agent, knownTools, seenModels, models, modelPool);
    }
  }

  // A2 (ADR-0008): cada agente ativo consome uma conta exclusiva (A4, ADR-0009).
  // O teto efetivo da v1 é 2; `maxActive` só é validado quando declarado.
  if (Object.keys(agents).length > 0) {
    const accounts = new Set(
      Object.entries(providers).map(([name, provider]) => providerAccountRefFor(name, provider)),
    ).size;
    const ceiling = maxActive ?? 2;
    if (ceiling > accounts) {
      fail(
        `config inválida: max_active_exceeds_accounts (${ceiling} agentes ativos para ${accounts} contas declaradas)`,
      );
    }
  }

  const spawn = root.spawn === undefined ? undefined : validateSpawn(root.spawn);

  // Validar seção tools (F4-6)
  const tools = root.tools === undefined ? undefined : validateTools(root.tools);
  // The legacy sandbox value becomes shell.mode only in memory; the file is never rewritten.
  const legacySandbox = tools?.run_command?.sandbox;
  const shell = root.shell === undefined && legacySandbox === undefined
    ? undefined
    : validateShell(root.shell, legacySandbox);
  // The current runtime consumes the legacy field; `off` must never fall back to auto.
  const effectiveTools: ToolsConfig | undefined = shell?.mode === "off"
    ? { ...tools, run_command: { ...tools?.run_command, sandbox: false } }
    : tools;

  // Validar telemetria (F5-5)
  const telemetry = root.telemetry === undefined ? undefined : validateTelemetry(root.telemetry);

  // Validar quota (F6-3)
  const quota = root.quota === undefined ? undefined : validateQuota(root.quota);

  // Validar cache (F6-4)
  const cache = root.cache === undefined ? undefined : validateCache(root.cache);

  // Validar plugins (F7-1): lista de strings não vazias
  let plugins: string[] | undefined;
  if (root.plugins !== undefined) {
    plugins = expectStringArray(root.plugins, "plugins");
  }

  // Versão semântica (ADR-0028): forma e compatibilidade já foram decididas por
  // `inspectConfigDocument`; ausente continua undefined (legado), nunca default.
  const version = typeof root.version === "string" ? root.version : undefined;

  // Team features (F7-5)
  const team = root.team === undefined ? undefined : validateTeam(root.team);

  // Handoff (F-24): timeout do ack com default seguro (D-15)
  const handoff = validateHandoff(root.handoff);

  // Budget (B1–B10) e guardas do loop (Q-01/L2)
  const budget = root.budget === undefined ? undefined : validateBudget(root.budget);
  const run = validateRun(root.run, agent.maxSteps);

  // Servidores MCP (C2, #56): ausente = nenhum servidor
  const mcpServers = root.mcpServers === undefined ? undefined : validateMcpServers(root.mcpServers);

  // web_search (#57): ausente = tool não registrada
  const webSearch = root.webSearch === undefined ? undefined : validateWebSearch(root.webSearch);

  // Memória (#532): ausente = default (8000 caracteres)
  const memory = root.memory === undefined ? undefined : validateMemory(root.memory);

  const paths = validatePaths(root.paths);

  // Segurança (ADR-0027, #391 slice 3b): ausente = sem seção `security`
  const security = root.security === undefined ? undefined : validateSecurity(root.security);
  const effort = root.effort === undefined ? undefined : validateEffort(root.effort);

  const config: AstroConfig = { preset, providers, models, modelPool, agent, agents, ...(maxActive === undefined ? {} : { maxActive }), tools: effectiveTools, telemetry, quota, cache, plugins, version, ...(meta.migrated ? { migratedFrom: meta.declaredVersion } : {}), team, handoff, permissions: validatePermissions(root.permissions), ...(shell === undefined ? {} : { shell }), ...(security === undefined ? {} : { security }), ...(effort === undefined ? {} : { effort }), attachments: validateAttachments(root.attachments), outputLimit: validateOutputLimit(root.outputLimit), compaction: validateCompaction(root.compaction), ...(webSearch === undefined ? {} : { webSearch }), ...(memory === undefined ? {} : { memory }), ...(budget === undefined ? {} : { budget }), run, ...(spawn === undefined ? {} : { spawn }), ...(pricing === undefined ? {} : { pricing }), ...(mcpServers === undefined ? {} : { mcpServers }), paths };
  if (checked.preset === undefined || isDerivedPreset(checked)) Object.defineProperty(config, DERIVED_PRESET, { value: true });
  return config;
}

/** Lê o JSON cru de um config, sem validar (o merge por camadas vem antes). */
export function loadConfigRaw(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`não foi possível ler a configuração em "${path}": ${detail}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // I-03: o detalhe do parser de JSON pode citar o conteúdo do arquivo — não ecoar.
    throw new ConfigError(`configuração em "${path}" não é JSON válido`);
  }

  if (!isPlainObject(raw)) fail('config inválida: "config" deve ser um objeto');
  return raw;
}

/** Lê um arquivo JSON de configuração e o valida. */
export function loadConfig(path: string): AstroConfig {
  return validateConfig(loadConfigRaw(path), { source: path });
}

/** Código de erro de sistema de arquivos (ENOENT, EACCES...), quando presente. */
function fsCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Falha de leitura classificada por `code` (#470): ENOENT e EACCES/EPERM têm
 * mensagem e próximo passo próprios. Nunca ecoa conteúdo do arquivo (I-03).
 */
function readConfigFailure(path: string, error: unknown): ConfigError {
  const code = fsCode(error);
  if (code === "ENOENT") {
    return new ConfigError(
      `configuração não encontrada: "${path}" — crie o arquivo explicitamente ou passe --config com outro caminho`,
      "config_not_found",
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ConfigError(
      `sem permissão para ler "${path}" (${code}) — corrija as permissões do arquivo ou escolha outro caminho`,
      "config_read_denied",
    );
  }
  return new ConfigError(
    `não foi possível ler "${path}"${code === undefined ? "" : ` (${code})`} — verifique o caminho; nada foi gravado`,
    "config_read_failed",
  );
}

/**
 * Posição do erro de JSON, derivada **só da mensagem** do parser: V8 (Node) põe
 * `position N` e, em versões novas, `(line N column M)`; JSC (Bun) não põe
 * posição na mensagem. `error.line`/`error.column` são ignorados: no Bun eles
 * são o frame da pilha de quem chamou `JSON.parse` (ex.: config.ts), então um
 * token ruim na linha 9 apareceria como linha 1714. As duas fontes passam pela
 * mesma régua: a linha precisa existir e a coluna precisa caber nela (mais uma
 * posição depois do fim, onde o parser aponta erro de fim de entrada). Offset
 * fora do arquivo é descartado, não realocado para o EOF. Nunca usamos o trecho
 * do arquivo que o parser cita (I-03).
 */
function jsonErrorPosition(text: string, error: unknown): { line: number; column: number } | undefined {
  const message = error instanceof Error ? error.message : "";
  const lines = text.split("\n");
  const accept = (line: number, column: number): { line: number; column: number } | undefined => {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) return undefined;
    if (line < 1 || line > lines.length || column < 1) return undefined;
    const target = lines[line - 1] ?? "";
    return column <= target.length + 1 ? { line, column } : undefined;
  };

  const inMessage = /\(line (\d+) column (\d+)\)/.exec(message);
  if (inMessage !== null) return accept(Number(inMessage[1]), Number(inMessage[2]));

  const offset = /position (\d+)/.exec(message)?.[1];
  if (offset === undefined) return undefined;
  const index = Number(offset);
  if (!Number.isSafeInteger(index) || index < 0 || index > text.length) return undefined;
  const before = text.slice(0, index);
  return accept(before.split("\n").length, index - before.lastIndexOf("\n"));
}

/** Mensagem de JSON inválido com linha/coluna quando disponível; nunca o conteúdo (I-03). */
function invalidJsonMessage(path: string, text: string, error: unknown): string {
  const at = jsonErrorPosition(text, error);
  const where = at === undefined ? "" : ` na linha ${at.line}, coluna ${at.column}`;
  return `JSON inválido em "${path}"${where} — corrija a sintaxe; o arquivo não foi alterado`;
}

/** Falha de escrita classificada por `code` (#470); o original fica intacto. */
function writeConfigFailure(path: string, error: unknown): ConfigError {
  const code = fsCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new ConfigError(
      `sem permissão para gravar "${path}" (${code}) — corrija as permissões ou escolha outro caminho; o arquivo original não foi alterado`,
      "config_write_denied",
    );
  }
  return new ConfigError(
    `não foi possível gravar "${path}"${code === undefined ? "" : ` (${code})`} — verifique permissões e espaço em disco; o arquivo original não foi alterado`,
    "config_write_failed",
  );
}

/**
 * Grava `contents` de forma atômica: tmp no mesmo diretório (0600 no POSIX e
 * DACL owner-only no Windows, ADR-0028), fsync, rename. Destino symlink ou
 * não-regular é recusado nomeando só o caminho; falha deixa o destino anterior
 * intacto e sem tmp órfão (#495, ADR-0028, I-03).
 */
export function writeConfigFileAtomic(path: string, contents: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new ConfigError(
        `não foi possível gravar "${path}": o destino é um symlink — use um arquivo regular; nada foi gravado`,
        "config_write_denied",
      );
    }
    if (existsSync(path) && !statSync(path).isFile()) {
      throw new ConfigError(
        `não foi possível gravar "${path}": o destino não é um arquivo regular; nada foi gravado`,
        "config_write_denied",
      );
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw writeConfigFailure(path, error);
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, contents, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Windows ignora o modo do `open`: a DACL owner-only vai no temporário antes
    // do rename; falha aborta a troca e o destino anterior fica intacto.
    if (process.platform === "win32") {
      try {
        hardenWindowsAclFile(tmp);
      } catch {
        throw new ConfigError(
          `não foi possível gravar "${path}": a ACL owner-only do arquivo temporário não pôde ser aplicada; nada foi gravado`,
          "config_write_denied",
        );
      }
    }
    renameSync(tmp, path);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
    if (error instanceof ConfigError) throw error;
    throw writeConfigFailure(path, error);
  }
  // Depois do rename o arquivo já é o novo: qualquer erro aqui é best-effort e
  // não pode virar "falha de escrita" (o chamador desfaria algo já aplicado).
  if (process.platform !== "win32") {
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // diretório não fsync-ável: o rename já garantiu a troca atômica
    }
  }
}

/**
 * Lê o JSON cru, aplica `mutate`, valida o resultado com `validateConfig` e
 * grava de forma atômica (tmp + fsync + rename, modo 0600). As quatro falhas de
 * leitura/parse/schema são `ConfigError` distintos, cada um com o próximo
 * passo (#470); qualquer falha deixa o arquivo original intacto (sem tmp
 * órfão) e nenhuma mensagem contém conteúdo do arquivo, segredo ou stack (I-03).
 */
function updateConfigFile(path: string, mutate: (raw: Record<string, unknown>) => void): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw readConfigFailure(path, error);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(invalidJsonMessage(path, text, error), "config_invalid_json");
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      `config inválida em "${path}": a raiz deve ser um objeto — corrija o arquivo; nada foi gravado`,
      "config_invalid_schema",
    );
  }
  try {
    mutate(raw);
    validateConfig(raw); // garante que a config resultante continua válida antes de gravar
  } catch (error) {
    // O detalhe já é a mensagem classificada (campo + valor esperado), sem conteúdo do arquivo.
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${detail} — corrija o campo indicado em "${path}"; o arquivo não foi alterado`, "config_invalid_schema");
  }
  writeConfigFileAtomic(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/**
 * Atualiza só `permissions.mode` no arquivo de config (#273, tela `/config`).
 */
export function updateConfigPermissionsMode(path: string, mode: PermissionMode): void {
  if (!isPermissionMode(mode)) {
    throw new ConfigError('config inválida: "permissions.mode" deve ser bypass, allow-edits ou ask');
  }
  updateConfigFile(path, (raw) => {
    raw.permissions = { ...(isPlainObject(raw.permissions) ? raw.permissions : {}), mode };
  });
}

/**
 * Troca só `providers.<provider>.credentialRef` (migração para o cofre,
 * #311 B.3). Aceita apenas `vault:<credentialId>` para não abrir um canal para
 * gravar segredo no arquivo (I-03).
 */
export function updateConfigProviderCredentialRef(path: string, provider: string, credentialRef: string): void {
  if (!isVaultCredentialRef(credentialRef)) {
    throw new ConfigError('credentialRef de vault inválido: use vault:<credentialId>');
  }
  updateConfigFile(path, (raw) => {
    const providers = raw.providers;
    if (!isPlainObject(providers) || !isPlainObject(providers[provider])) {
      throw new ConfigError(`config inválida: provider "${provider}" não encontrado`);
    }
    const entry = providers[provider];
    if (entry.kind !== "openai-compat") {
      throw new ConfigError(`config inválida: provider "${provider}" não é openai-compat`);
    }
    entry.credentialRef = credentialRef;
  });
}
