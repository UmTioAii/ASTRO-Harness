/**
 * Camadas de configuração (ADR-0029, #401): merge `global < projeto` e guarda
 * de estreitamento — o projeto só pode restringir a camada global; o merge não
 * aplica segurança (o estreitamento é conferido na validação).
 */
import { ConfigError, isPlainObject } from "./config";

/** Ranque de permissão: `ask` é o mais restrito, `bypass` o mais largo. */
const MODE_RANK: Record<string, number> = { ask: 0, "allow-edits": 1, bypass: 2 };

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
 * O projeto estreita a camada global, nunca amplia (ADR-0029): `tools` fica
 * dentro da allowlist global, `permissions.mode` fica mais restrito e o budget
 * não passa do teto global.
 */
export function assertNarrowed(global: Record<string, unknown>, merged: Record<string, unknown>): void {
  const allowed = at(global, "agent", "tools");
  const declared = at(merged, "agent", "tools");
  if (Array.isArray(allowed) && Array.isArray(declared)) {
    const extra = declared.filter((tool) => !allowed.map(String).includes(String(tool)));
    if (extra.length > 0) throw new ConfigError(`config inválida: o projeto amplia a allowlist global (${extra.join(", ")})`);
  }
  const before = at(global, "permissions", "mode");
  const after = at(merged, "permissions", "mode");
  const from = typeof before === "string" ? MODE_RANK[before] : undefined;
  const to = typeof after === "string" ? MODE_RANK[after] : undefined;
  if (from !== undefined && to !== undefined && to > from) {
    throw new ConfigError(`config inválida: o projeto amplia o modo de permissão global ("${before}" → "${after}")`);
  }
  const globalBudget = isPlainObject(global.budget) ? global.budget : {};
  const mergedBudget = isPlainObject(merged.budget) ? merged.budget : {};
  for (const key of ["limitUsd", "hardCeilingUsd"]) {
    const ceiling = globalBudget[key];
    const value = mergedBudget[key];
    if (typeof ceiling !== "number") continue;
    if (typeof value === "number" && value > ceiling) {
      throw new ConfigError(`config inválida: o projeto amplia o budget global (${key}: ${value} > ${ceiling})`);
    }
  }
}

/** Campo em `raw.secao.chave`; ausente = undefined. */
function at(raw: Record<string, unknown>, section: string, key: string): unknown {
  const block = raw[section];
  return isPlainObject(block) ? block[key] : undefined;
}
