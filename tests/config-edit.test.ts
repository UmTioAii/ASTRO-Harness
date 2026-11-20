/** Testes unitários do /config edit (whitelist, parse e gravação, #558). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDITABLE_CONFIG_KEYS,
  applyConfigEditsToRaw,
  isEditableConfigKey,
  parseConfigEditValue,
  updateConfigKnobs,
} from "../src/core/config-edit";
import { loadConfig, loadConfigRaw } from "../src/core/config";

function writeProject(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-config-edit-"));
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

const BASE = {
  agent: { model: "p/m1", maxSteps: 3, tools: ["read_file"] },
  providers: { p: { kind: "openai-compat", baseUrl: "https://api.example.com/v1", credentialRef: "KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
};

describe("isEditableConfigKey (#558)", () => {
  test("aceita só a whitelist fechada", () => {
    for (const key of EDITABLE_CONFIG_KEYS) expect(isEditableConfigKey(key)).toBe(true);
    expect(isEditableConfigKey("run.maxTurns")).toBe(false); // removido no P4
    expect(isEditableConfigKey("agent.tools")).toBe(false);
    expect(isEditableConfigKey("providers.p.apiKey")).toBe(false); // nunca credencial
    expect(isEditableConfigKey("")).toBe(false);
    expect(isEditableConfigKey(42)).toBe(false);
  });
});

describe("parseConfigEditValue (#558)", () => {
  test("agent.maxSteps: inteiro >= 1", () => {
    expect(parseConfigEditValue("agent.maxSteps", "200")).toBe(200);
    expect(parseConfigEditValue("agent.maxSteps", " 7 ")).toBe(7);
    expect(() => parseConfigEditValue("agent.maxSteps", "abc")).toThrow(/agent\.maxSteps/);
    expect(() => parseConfigEditValue("agent.maxSteps", "0")).toThrow(/agent\.maxSteps/);
    expect(() => parseConfigEditValue("agent.maxSteps", "-5")).toThrow(/agent\.maxSteps/);
    expect(() => parseConfigEditValue("agent.maxSteps", "1.5")).toThrow(/agent\.maxSteps/);
  });

  test("budget.* e team.*: números >= 0, warnAt entre 0 e 1, scope/onExceed fechados", () => {
    expect(parseConfigEditValue("budget.limitUsd", "12.5")).toBe(12.5);
    expect(parseConfigEditValue("budget.limitUsd", "null")).toBe(null);
    expect(() => parseConfigEditValue("team.sessionBudgetUsd", "null")).toThrow(/team\.sessionBudgetUsd/);
    expect(() => parseConfigEditValue("budget.limitUsd", "-1")).toThrow(/budget\.limitUsd/);
    expect(parseConfigEditValue("budget.warnAt", "0.8")).toBe(0.8);
    expect(() => parseConfigEditValue("budget.warnAt", "1")).toThrow(/budget\.warnAt/);
    expect(() => parseConfigEditValue("budget.warnAt", "0")).toThrow(/budget\.warnAt/);
    expect(parseConfigEditValue("budget.scope", "use-as-you-go")).toBe("use-as-you-go");
    expect(() => parseConfigEditValue("budget.scope", "year")).toThrow(/budget\.scope/);
    expect(parseConfigEditValue("budget.onExceed", "stop")).toBe("stop");
    expect(() => parseConfigEditValue("budget.onExceed", "explode")).toThrow(/budget\.onExceed/);
    expect(parseConfigEditValue("team.projectBudgetUsd", "100")).toBe(100);
  });

  test("permissions.mode: só os modos válidos", () => {
    expect(parseConfigEditValue("permissions.mode", "bypass")).toBe("bypass");
    expect(() => parseConfigEditValue("permissions.mode", "sudo")).toThrow(/permissions\.mode/);
  });
});

describe("applyConfigEditsToRaw (#558)", () => {
  test("aplica aninhado no raw sem tocar em outras chaves", () => {
    const raw = loadConfigRaw(writeProject(BASE));
    applyConfigEditsToRaw(raw, { "agent.maxSteps": "50", "budget.onExceed": "stop" });
    expect(raw.agent).toMatchObject({ maxSteps: 50, model: "p/m1" });
    expect(raw.budget).toEqual({ onExceed: "stop" }); // cria a seção
  });

  test("chave fora da whitelist é recusada", () => {
    const raw = loadConfigRaw(writeProject(BASE));
    expect(() => applyConfigEditsToRaw(raw, { "agent.tools": "[]" } as never)).toThrow(/não editável/);
    expect(() => applyConfigEditsToRaw(raw, {} as never)).toThrow(/nenhuma chave/);
  });

  test("preset simple deixa knobs control-only read-only", () => {
    const raw = loadConfigRaw(writeProject({ ...BASE, preset: "simple" }));
    expect(() => applyConfigEditsToRaw(raw, { "agent.maxSteps": "100" })).toThrow(/"control"/);
    expect(() => applyConfigEditsToRaw(raw, { "team.sessionBudgetUsd": "10" })).toThrow(/"control"/);
    applyConfigEditsToRaw(raw, { "permissions.mode": "allow-edits" }); // modo segue editável (#273)
    expect(raw.permissions).toEqual({ mode: "allow-edits" });
  });
});

describe("updateConfigKnobs (#558)", () => {
  test("grava no arquivo e o loadConfig relê o valor novo", () => {
    const path = writeProject(BASE);
    updateConfigKnobs(path, { "agent.maxSteps": "50" });
    expect(loadConfig(path).agent.maxSteps).toBe(50);
    expect(loadConfigRaw(path).agent).toMatchObject({ maxSteps: 50, model: "p/m1" });
  });

  test("falha de validação deixa o arquivo byte a byte intacto", () => {
    const path = writeProject(BASE);
    const before = readFileSync(path, "utf8");
    expect(() => updateConfigKnobs(path, { "agent.maxSteps": "abc" })).toThrow(/agent\.maxSteps/);
    expect(() => updateConfigKnobs(path, { "chave.falsa": "1" } as never)).toThrow(/não editável/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("pré-valida contra o teto global (ADR-0029): projeto não amplia maxSteps global", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-global-edit-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent: { maxSteps: 20 } }));
    const path = writeProject(BASE);
    const before = readFileSync(path, "utf8");
    expect(() => updateConfigKnobs(path, { "agent.maxSteps": "50" }, { env: { ASTRO_HOME: home } })).toThrow(/teto global/);
    expect(readFileSync(path, "utf8")).toBe(before);
    updateConfigKnobs(path, { "agent.maxSteps": "10" }, { env: { ASTRO_HOME: home } }); // estreita: ok
    expect(loadConfig(path).agent.maxSteps).toBe(10);
  });

  test("ASTRO_NO_GLOBAL_CONFIG=1 desliga a pré-validação global", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-global-edit-off-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ agent: { maxSteps: 20 } }));
    const path = writeProject(BASE);
    updateConfigKnobs(path, { "agent.maxSteps": "50" }, { env: { ASTRO_HOME: home, ASTRO_NO_GLOBAL_CONFIG: "1" } });
    expect(loadConfig(path).agent.maxSteps).toBe(50);
  });
});
