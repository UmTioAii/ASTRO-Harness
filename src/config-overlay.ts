/**
 * Camadas de configuração (ADR-0029, #401): merge `global < projeto` e guarda
 * de estreitamento — o projeto só pode restringir a camada global; o merge não
 * aplica segurança (o estreitamento é conferido na validação).
 */
import { ConfigError, isPlainObject } from "./config";

/** Ranque de permissão: `ask` é o mais restrito, `bypass` o mais largo. */
const MODE_RANK: Record<string, number> = { ask: 0, "allow-edits": 1, bypass: 2 };
/** Ranque do perfil de permissão do agent: `read-only` é o mais restrito. */
const PERMISSION_RANK: Record<string, number> = { "read-only": 0, write: 1, execute: 2, full: 3 };

/** Mescla camadas: objetos por chave, arrays substituem, escalares substituem. */
export function mergeConfigLayers(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (key === "models") {
      merged[key] = mergeModelLayers(Array.isArray(current) ? current : [], Array.isArray(value) ? value : []);
    } else if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeConfigLayers(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** `models` une por `provider/id`; a camada de cima prevalece no conflito. */
export function mergeModelLayers(base: readonly unknown[], overlay: readonly unknown[]): unknown[] {
  const merged = new Map<string, unknown>();
  let index = 0;
  for (const model of [...base, ...overlay]) {
    const key = isPlainObject(model) && typeof model.provider === "string" && typeof model.id === "string"
      ? `${model.provider}/${model.id}`
      : `#${index}`; // modelo inválido fica à parte para a validação reportar
    merged.set(key, model);
    index += 1;
  }
  return [...merged.values()];
}

/**
 * O projeto estreita a camada global, nunca amplia (ADR-0029): tools e perfil
 * de permissão ficam dentro do global, `permissions.mode` fica mais restrito, o
 * budget não passa do teto global e a credencial global não muda de host.
 */
export function assertNarrowed(global: Record<string, unknown>, merged: Record<string, unknown>): void {
  // Agent principal e agents nomeados: tools e perfil de permissão.
  const mainGlobal = isPlainObject(global.agent) ? global.agent : undefined;
  const mainMerged = isPlainObject(merged.agent) ? merged.agent : undefined;
  if (mainGlobal !== undefined && mainMerged !== undefined) {
    assertAgentNarrowed(mainGlobal, mainMerged, "do agent principal");
  }
  const globalAgents = isPlainObject(global.agents) ? global.agents : {};
  const mergedAgents = isPlainObject(merged.agents) ? merged.agents : {};
  for (const [name, globalAgent] of Object.entries(globalAgents)) {
    const mergedAgent = mergedAgents[name];
    if (isPlainObject(globalAgent) && isPlainObject(mergedAgent)) {
      assertAgentNarrowed(globalAgent, mergedAgent, `do agent "${name}"`);
    }
  }

  // Modo de permissão do gate.
  const before = at(global, "permissions", "mode");
  const after = at(merged, "permissions", "mode");
  const from = typeof before === "string" ? MODE_RANK[before] : undefined;
  const to = typeof after === "string" ? MODE_RANK[after] : undefined;
  if (from !== undefined && to !== undefined && to > from) {
    throw new ConfigError(`config inválida: o projeto amplia o modo de permissão global ("${before}" → "${after}")`);
  }

  // Budget: teto e escopo não podem crescer.
  const globalBudget = isPlainObject(global.budget) ? global.budget : {};
  const mergedBudget = isPlainObject(merged.budget) ? merged.budget : {};
  for (const key of ["limitUsd", "hardCeilingUsd"]) {
    const ceiling = globalBudget[key];
    const value = mergedBudget[key];
    if (typeof ceiling !== "number") continue;
    if (typeof value !== "number" || value > ceiling) {
      throw new ConfigError(`config inválida: o projeto amplia o budget global (${key}: ${String(value)} > ${ceiling})`);
    }
  }
  if (globalBudget.scope !== undefined && globalBudget.scope !== "use-as-you-go" && mergedBudget.scope === "use-as-you-go") {
    throw new ConfigError(`config inválida: o projeto amplia o budget global (scope: ${String(globalBudget.scope)} → use-as-you-go)`);
  }

  // Provider global: o projeto não muda o host heritando a credencial global.
  const globalProviders = isPlainObject(global.providers) ? global.providers : {};
  const mergedProviders = isPlainObject(merged.providers) ? merged.providers : {};
  for (const [id, globalProvider] of Object.entries(globalProviders)) {
    const mergedProvider = mergedProviders[id];
    if (!isPlainObject(globalProvider) || !isPlainObject(mergedProvider)) continue;
    const moved = ["baseUrl", "kind"].some((key) => mergedProvider[key] !== globalProvider[key]);
    const inherited = ["credentialRef", "credentialsPath"].some(
      (key) => globalProvider[key] !== undefined && mergedProvider[key] === globalProvider[key],
    );
    if (moved && inherited) {
      throw new ConfigError(`config inválida: o projeto redireciona a credencial global do provider "${id}"`);
    }
  }
}

/**
 * Tools e perfil de permissão de um agent: o projeto só escolhe tools da
 * allowlist global e um perfil mais restrito.
 */
function assertAgentNarrowed(globalAgent: Record<string, unknown>, mergedAgent: Record<string, unknown>, label: string): void {
  const allowed = globalAgent.tools;
  const declared = mergedAgent.tools;
  if (Array.isArray(allowed) && Array.isArray(declared)) {
    const extra = declared.filter((tool) => !allowed.map(String).includes(String(tool)));
    if (extra.length > 0) throw new ConfigError(`config inválida: o projeto amplia a allowlist global ${label} (${extra.join(", ")})`);
  }
  const from = globalAgent.permission;
  const to = mergedAgent.permission;
  const before = typeof from === "string" ? PERMISSION_RANK[from] : undefined;
  const after = typeof to === "string" ? PERMISSION_RANK[to] : undefined;
  if (before !== undefined && after !== undefined && after > before) {
    throw new ConfigError(`config inválida: o projeto amplia a permissão global ${label} ("${from}" → "${to}")`);
  }
}

/** Campo em `raw.secao.chave`; ausente = undefined. */
function at(raw: Record<string, unknown>, section: string, key: string): unknown {
  const block = raw[section];
  return isPlainObject(block) ? block[key] : undefined;
}
