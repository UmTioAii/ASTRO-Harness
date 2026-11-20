/**
 * Edição de knobs pelo `/config` (#558): whitelist fechada de chaves, parse do
 * valor digitado (pt-BR), pré-validação contra a camada global (ADR-0029) e
 * gravação atômica. Nenhuma mensagem ecoa conteúdo do arquivo (I-03).
 */
import { isPermissionMode } from "../permissions";
import { validateProjectLayer } from "../providers/profiles";
import { ConfigError, isPlainObject, loadConfigRaw, writeConfigFileAtomic } from "./config";

/** Chaves editáveis via `/config` (#558); fora daqui é recusado. */
export const EDITABLE_CONFIG_KEYS = [
  "agent.maxSteps",
  "budget.scope",
  "budget.limitUsd",
  "budget.warnAt",
  "budget.onExceed",
  "budget.hardCeilingUsd",
  "team.projectBudgetUsd",
  "team.sessionBudgetUsd",
  "team.weekBudgetUsd",
  "permissions.mode",
] as const;

export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];

/** Guard de runtime para input externo (whitelist fechada). */
export function isEditableConfigKey(value: unknown): value is EditableConfigKey {
  return typeof value === "string" && (EDITABLE_CONFIG_KEYS as readonly string[]).includes(value);
}

/** Knobs só do preset `control` (#515/#552): no `simple` o /config fica read-only neles (#558). */
const CONTROL_ONLY_KEYS: ReadonlySet<string> = new Set(["agent.maxSteps", "team.sessionBudgetUsd", "team.weekBudgetUsd"]);

const USD_KEYS: ReadonlySet<string> = new Set([
  "budget.limitUsd",
  "budget.hardCeilingUsd",
  "team.projectBudgetUsd",
  "team.sessionBudgetUsd",
  "team.weekBudgetUsd",
]);

const BUDGET_SCOPES: readonly string[] = ["day", "month", "project", "use-as-you-go"];

/**
 * Faz o parse do valor digitado (string) para o tipo da chave; lança
 * `ConfigError` em pt-BR sem tocar no disco. O resultado ainda passa pelo
 * `validateConfig` na gravação.
 */
export function parseConfigEditValue(key: EditableConfigKey, raw: string): unknown {
  const text = raw.trim();
  if (key === "agent.maxSteps") {
    if (!/^\d+$/.test(text) || Number(text) < 1) {
      throw new ConfigError(`valor inválido para "agent.maxSteps": deve ser inteiro >= 1 (ex.: 200) — recebido "${text}"`);
    }
    return Number(text);
  }
  if (USD_KEYS.has(key)) {
    if (text.toLowerCase() === "null") {
      if (key !== "budget.limitUsd") throw new ConfigError(`valor inválido para "${key}": null só vale em "budget.limitUsd" (use-as-you-go)`);
      return null;
    }
    const value = Number(text);
    if (text === "" || !Number.isFinite(value) || value < 0) {
      throw new ConfigError(`valor inválido para "${key}": deve ser número >= 0 — recebido "${text}"`);
    }
    return value;
  }
  if (key === "budget.warnAt") {
    const value = Number(text);
    if (text === "" || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new ConfigError(`valor inválido para "budget.warnAt": deve ser número entre 0 e 1 exclusive (ex.: 0.8) — recebido "${text}"`);
    }
    return value;
  }
  if (key === "budget.scope") {
    if (!BUDGET_SCOPES.includes(text)) {
      throw new ConfigError(`valor inválido para "budget.scope": deve ser ${BUDGET_SCOPES.join(", ")} — recebido "${text}"`);
    }
    return text;
  }
  if (key === "budget.onExceed") {
    if (text !== "ask" && text !== "stop") {
      throw new ConfigError(`valor inválido para "budget.onExceed": deve ser ask ou stop — recebido "${text}"`);
    }
    return text;
  }
  // permissions.mode
  if (!isPermissionMode(text)) {
    throw new ConfigError(`valor inválido para "permissions.mode": deve ser bypass, allow-edits ou ask — recebido "${text}"`);
  }
  return text;
}

/** Grava `key = value` no objeto aninhado (ex.: "agent.maxSteps" → raw.agent.maxSteps). */
function setNested(raw: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let node = raw;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!isPlainObject(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * Aplica os edits (valores em texto, como digitados) no raw, mutando-o:
 * valida a whitelist, o preset `simple` (knobs control-only ficam read-only) e
 * faz o parse de cada valor. Lança `ConfigError` sem tocar no disco.
 */
export function applyConfigEditsToRaw(
  raw: Record<string, unknown>,
  edits: Partial<Record<EditableConfigKey, string>>,
): void {
  const entries = Object.entries(edits) as [string, string][];
  if (entries.length === 0) {
    throw new ConfigError(`nenhuma chave para editar — editáveis via /config: ${EDITABLE_CONFIG_KEYS.join(", ")}`);
  }
  for (const [key] of entries) {
    if (!isEditableConfigKey(key)) {
      throw new ConfigError(`chave não editável via /config: "${key}" — editáveis: ${EDITABLE_CONFIG_KEYS.join(", ")}`);
    }
  }
  if (raw.preset === "simple") {
    for (const [key] of entries) {
      if (CONTROL_ONLY_KEYS.has(key)) {
        throw new ConfigError(
          `"${key}" só pode ser alterado com "preset": "control" — no preset "simple" o /config fica read-only nesse knob`,
        );
      }
    }
  }
  for (const [key, rawValue] of entries) {
    setNested(raw, key, parseConfigEditValue(key as EditableConfigKey, rawValue));
  }
}

/**
 * Grava os knobs no arquivo de config (#558): lê o raw, aplica os edits,
 * pré-valida o merge com a camada global (ADR-0029, igual ao load) e grava de
 * forma atômica (tmp + fsync + rename). Qualquer falha (leitura, parse, chave
 * desconhecida, valor inválido, preset simple, teto global) deixa o arquivo
 * original intacto e não altera o runtime.
 */
export function updateConfigKnobs(
  path: string,
  edits: Partial<Record<EditableConfigKey, string>>,
  opts: { env?: NodeJS.ProcessEnv } = {},
): void {
  const raw = loadConfigRaw(path);
  const next = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  applyConfigEditsToRaw(next, edits);
  validateProjectLayer(next, { ...process.env, ...opts.env });
  writeConfigFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}
