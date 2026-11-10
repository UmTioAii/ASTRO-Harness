/** Camadas de configuração (ADR-0029, #401): merge `global < projeto` e guarda
 * de estreitamento — o projeto só pode restringir a camada global. */
import { ConfigError, isPlainObject } from "./config";

/** Ranque de permissão: `ask` é o mais restrito, `bypass` o mais largo. */
const MODE_RANK: Record<string, number> = { ask: 0, "allow-edits": 1, bypass: 2 };
/** Ranque do perfil do agent: `read-only` é o mais restrito. */
const PERMISSION_RANK: Record<string, number> = { "read-only": 0, write: 1, execute: 2, full: 3 };
/** Janela do budget: a mensal é a mais estreita; o dia gasta o teto todo dia. */
const SCOPE_RANK: Record<string, number> = { month: 0, project: 0, day: 1, "use-as-you-go": 2 };
/** Chaves de credencial: guardam a referência, nunca o valor. */
const CREDENTIAL_KEYS = ["credentialRef", "credentialsPath"];

/** Mescla camadas: objetos por chave, arrays substituem, escalares substituem. */
export function mergeConfigLayers(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (key === "models" && Array.isArray(current) && Array.isArray(value)) merged[key] = mergeModelLayers(current, value);
    else if (isPlainObject(current) && isPlainObject(value)) {
      const next = mergeConfigLayers(current, value);
      // `model` e `profile` são uma chave lógica (o schema proíbe os dois):
      // declarar um no projeto descarta o herdado da camada global.
      if (value.model !== undefined) delete (next as Record<string, unknown>).profile;
      else if (value.profile !== undefined) delete (next as Record<string, unknown>).model;
      merged[key] = next;
    } else merged[key] = value;
  }
  return merged;
}

/** `models` une por `provider/id`; a camada de cima prevalece no conflito. */
export function mergeModelLayers(base: readonly unknown[], overlay: readonly unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  let index = 0;
  for (const model of [...base, ...overlay]) {
    const key = isPlainObject(model) && typeof model.provider === "string" && typeof model.id === "string"
      ? `${model.provider}/${model.id}` : `#${index}`; // modelo inválido fica à parte
    merged.set(key, model);
    index += 1;
  }
  return [...merged.values()];
}

/**
 * O projeto estreita a camada global, nunca amplia (ADR-0029): tools e perfil de
 * permissão ficam dentro do global, `permissions.mode` fica mais restrito, o
 * budget não passa do teto global e a credencial global não muda de host.
 */
export function assertNarrowed(global: Record<string, unknown>, merged: Record<string, unknown>, storeProviders: Record<string, unknown> = {}): void {
  // Agent principal e agents nomeados: tools e perfil de permissão.
  const main = isPlainObject(global.agent) ? global.agent : undefined;
  const mainAfter = isPlainObject(merged.agent) ? merged.agent : undefined;
  if (main !== undefined && mainAfter !== undefined) assertAgentNarrowed(main, mainAfter, "do agent principal");
  const named = isPlainObject(global.agents) ? global.agents : {};
  const namedAfter = isPlainObject(merged.agents) ? merged.agents : {};
  for (const [name, agent] of Object.entries(named)) {
    const after = namedAfter[name];
    if (isPlainObject(agent) && isPlainObject(after)) assertAgentNarrowed(agent, after, `do agent "${name}"`);
  }
  // Modo de permissão do gate: o projeto só pode ser mais restrito.
  const globalMode = isPlainObject(global.permissions) ? global.permissions.mode : undefined;
  const mergedMode = isPlainObject(merged.permissions) ? merged.permissions.mode : undefined;
  assertNotWider(globalMode, mergedMode, MODE_RANK, "o modo de permissão global");
  // Budget: teto, janela e escopo não podem crescer.
  const globalBudget = isPlainObject(global.budget) ? global.budget : {};
  const mergedBudget = isPlainObject(merged.budget) ? merged.budget : {};
  for (const key of ["limitUsd", "hardCeilingUsd"]) {
    const ceiling = globalBudget[key];
    const value = mergedBudget[key];
    if (typeof ceiling === "number" && (typeof value !== "number" || value > ceiling)) {
      throw new ConfigError(`config inválida: o projeto amplia o budget global (${key} acima do teto global)`);
    }
  }
  const scopeFrom = SCOPE_RANK[String(globalBudget.scope)];
  const scopeTo = SCOPE_RANK[String(mergedBudget.scope)];
  if (scopeFrom !== undefined && scopeTo !== undefined && scopeTo > scopeFrom) {
    throw new ConfigError("config inválida: o projeto amplia o budget global (a janela do escopo não pode encolher)");
  }
  if (globalBudget.onExceed === "stop" && mergedBudget.onExceed === "ask") {
    throw new ConfigError("config inválida: o projeto amplia o budget global (onExceed: stop → ask)");
  }
  // Provider: a credencial global não muda de host (comparação pela referência).
  const endpoints = new Map<string, string>();
  const globalProviders = isPlainObject(global.providers) ? global.providers : {};
  for (const provider of [...Object.values(globalProviders), ...Object.values(storeProviders)]) {
    if (!isPlainObject(provider)) continue;
    const endpoint = `${String(provider.baseUrl)}|${String(provider.kind)}`;
    for (const key of CREDENTIAL_KEYS) if (typeof provider[key] === "string") endpoints.set(`${key}=${provider[key]}`, endpoint);
  }
  const mergedProviders = isPlainObject(merged.providers) ? merged.providers : {};
  for (const [id, provider] of Object.entries(mergedProviders)) {
    if (!isPlainObject(provider)) continue;
    const endpoint = `${String(provider.baseUrl)}|${String(provider.kind)}`;
    for (const key of CREDENTIAL_KEYS) {
      const ref = provider[key];
      const origin = typeof ref === "string" ? endpoints.get(`${key}=${ref}`) : undefined;
      if (origin !== undefined && origin !== endpoint) {
        throw new ConfigError(`config inválida: o projeto redireciona a credencial global do provider "${id}"`);
      }
    }
  }
}

/** Tools e perfil de permissão de um agent: só o que o global permite. */
function assertAgentNarrowed(globalAgent: Record<string, unknown>, mergedAgent: Record<string, unknown>, label: string): void {
  const allowed = globalAgent.tools;
  const declared = mergedAgent.tools;
  if (Array.isArray(allowed) && Array.isArray(declared)) {
    const extra = declared.filter((tool) => !allowed.map(String).includes(String(tool)));
    if (extra.length > 0) throw new ConfigError(`config inválida: o projeto amplia a allowlist global ${label} (${extra.join(", ")})`);
  }
  assertNotWider(globalAgent.permission, mergedAgent.permission, PERMISSION_RANK, `a permissão global ${label}`);
}

/** Rejeita quando o projeto é mais permissivo que o global. */
function assertNotWider(globalValue: unknown, mergedValue: unknown, table: Record<string, number>, label: string): void {
  const from = typeof globalValue === "string" ? table[globalValue] : undefined;
  const to = typeof mergedValue === "string" ? table[mergedValue] : undefined;
  if (from !== undefined && to !== undefined && to > from) {
    throw new ConfigError(`config inválida: o projeto amplia ${label} ("${String(globalValue)}" → "${String(mergedValue)}")`);
  }
}
