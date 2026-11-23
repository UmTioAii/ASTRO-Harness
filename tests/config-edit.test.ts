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
    expect(isEditableConfigKey("run.maxTurns")).toBe(true);
    expect(isEditableConfigKey("run.maxRoundsPerTurn")).toBe(true);
    expect(isEditableConfigKey("preset")).toBe(true);
    expect(isEditableConfigKey("agent.maxSteps")).toBe(false);
    expect(isEditableConfigKey("agent.tools")).toBe(false);
    expect(isEditableConfigKey("providers.p.apiKey")).toBe(false); // nunca credencial
    expect(isEditableConfigKey("")).toBe(false);
    expect(isEditableConfigKey(42)).toBe(false);
  });
});

describe("parseConfigEditValue (#558)", () => {
  test("run limits accept only their published choices", () => {
    expect(parseConfigEditValue("run.maxTurns", "250")).toBe(250);
    expect(parseConfigEditValue("run.maxTurns", "unlimited")).toBe("unlimited");
    expect(parseConfigEditValue("run.maxRoundsPerTurn", " 100 ")).toBe(100);
    expect(parseConfigEditValue("run.maxRoundsPerTurn", "unlimited")).toBe("unlimited");
    expect(() => parseConfigEditValue("run.maxTurns", "600")).toThrow(/run\.maxTurns/);
    expect(() => parseConfigEditValue("run.maxRoundsPerTurn", "50")).toThrow(/run\.maxRoundsPerTurn/);
  });

  test("preset accepts Default and Control", () => {
    expect(parseConfigEditValue("preset", "default")).toBe("default");
    expect(parseConfigEditValue("preset", "control")).toBe("control");
    expect(() => parseConfigEditValue("preset", "turbo")).toThrow(/preset/);
  });

  test("errors never echo arbitrary input", () => {
    const secret = "sensitive-value-do-not-echo";
    const keys = ["run.maxTurns", "run.maxRoundsPerTurn", "preset", "budget.limitUsd", "budget.warnAt", "budget.scope", "budget.onExceed", "shell.default", "permissions.mode"] as const;
    for (const key of keys) {
      let message = "";
      try { parseConfigEditValue(key, secret); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
    const raw = loadConfigRaw(writeProject(BASE));
    let message = "";
    try { applyConfigEditsToRaw(raw, { [secret]: "1" } as never); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toContain(secret);
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
    const raw = loadConfigRaw(writeProject({ ...BASE, preset: "control" }));
    applyConfigEditsToRaw(raw, { "run.maxRoundsPerTurn": "100", "budget.onExceed": "stop" });
    expect(raw.run).toEqual({ maxRoundsPerTurn: 100 });
    expect(raw.agent).toMatchObject({ maxSteps: 3, model: "p/m1" });
    expect(raw.budget).toEqual({ onExceed: "stop" }); // cria a seção
  });

  test("chave fora da whitelist é recusada", () => {
    const raw = loadConfigRaw(writeProject(BASE));
    expect(() => applyConfigEditsToRaw(raw, { "agent.tools": "[]" } as never)).toThrow(/não editável/);
    expect(() => applyConfigEditsToRaw(raw, {} as never)).toThrow(/nenhuma chave/);
  });

  test("Default leaves advanced knobs read-only and Control is reversible", () => {
    const raw = loadConfigRaw(writeProject({ ...BASE, version: "1.0.0", preset: "simple" }));
    expect(() => applyConfigEditsToRaw(raw, { "run.maxRoundsPerTurn": "100" })).toThrow(/"control"/);
    expect(() => applyConfigEditsToRaw(raw, { "team.sessionBudgetUsd": "10" })).toThrow(/"control"/);
    applyConfigEditsToRaw(raw, { preset: "control", "permissions.mode": "allow-edits" });
    expect(raw.preset).toBe("control");
    expect(raw.permissions).toEqual({ mode: "allow-edits" });
    applyConfigEditsToRaw(raw, { preset: "default" });
    expect(raw.preset).toBe("default");
    expect(raw.version).toBe("1.0.0");
  });
});

describe("updateConfigKnobs (#558)", () => {
  test("writes the new round key without rewriting the legacy alias", () => {
    const path = writeProject({ ...BASE, preset: "control" });
    updateConfigKnobs(path, { "run.maxRoundsPerTurn": "100" });
    expect(loadConfig(path).run).toMatchObject({ maxRoundsPerTurn: 100 });
    expect(loadConfigRaw(path).agent).toMatchObject({ maxSteps: 3, model: "p/m1" });
  });

  test("schema opt-in never downgrades a newer minor", () => {
    for (const [version, expected] of [[undefined, "2.0.0"], ["1.0.0", "2.0.0"], ["2.1.0", "2.1.0"]] as const) {
      const path = writeProject({ ...BASE, version });
      updateConfigKnobs(path, { "run.maxTurns": "1000" }, { env: { ASTRO_NO_GLOBAL_CONFIG: "1" } });
      expect(loadConfigRaw(path).version).toBe(expected);
    }
  });

  test("falha de validação deixa o arquivo byte a byte intacto", () => {
    const path = writeProject(BASE);
    const before = readFileSync(path, "utf8");
    expect(() => updateConfigKnobs(path, { "run.maxTurns": "600" })).toThrow(/run\.maxTurns/);
    expect(() => updateConfigKnobs(path, { "chave.falsa": "1" } as never)).toThrow(/não editável/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("inherits global Control without overriding explicit project Default", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-global-control-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: "2.0.0", preset: "control" }));
    const env = { ASTRO_HOME: home }, inherited = writeProject({ ...BASE, version: "2.0.0" });
    updateConfigKnobs(inherited, { "run.maxRoundsPerTurn": "100" }, { env });
    expect(loadConfigRaw(inherited).run).toEqual({ maxRoundsPerTurn: 100 });
    const explicit = writeProject({ ...BASE, version: "2.0.0", preset: "default" }), before = readFileSync(explicit, "utf8");
    expect(() => updateConfigKnobs(explicit, { "run.maxRoundsPerTurn": "100" }, { env })).toThrow(/"control"/);
    expect(readFileSync(explicit, "utf8")).toBe(before);
    updateConfigKnobs(explicit, { preset: "control" }, { env });
    updateConfigKnobs(explicit, { preset: "default" }, { env });
    expect(loadConfigRaw(explicit).preset).toBe("default");
  });

  test("pre-validates global turn and round ceilings without rewriting the file", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-global-edit-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: "2.0.0", run: { maxTurns: 250, maxRoundsPerTurn: 200 } }));
    for (const [key, widened, narrowed] of [["run.maxTurns", "1000", "250"], ["run.maxRoundsPerTurn", "500", "100"]] as const) {
      const path = writeProject({ ...BASE, preset: "control" }), before = readFileSync(path, "utf8");
      expect(() => updateConfigKnobs(path, { [key]: widened }, { env: { ASTRO_HOME: home } })).toThrow(/teto global/);
      expect(readFileSync(path, "utf8")).toBe(before);
      updateConfigKnobs(path, { [key]: narrowed }, { env: { ASTRO_HOME: home } });
      expect(loadConfigRaw(path).run).toMatchObject({ [key.split(".")[1]!]: Number(narrowed) });
    }
  });

  test("rejects non-object sections without replacing user-authored values", () => {
    for (const run of ["INVALID-USER-VALUE", null, []]) {
      const path = writeProject({ ...BASE, run }), before = readFileSync(path, "utf8");
      let message = "";
      try { updateConfigKnobs(path, { "run.maxTurns": "250" }); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe(""); expect(message).not.toContain("INVALID-USER-VALUE");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  test("Control returns to Default without deleting advanced declarations", () => {
    const path = writeProject({ ...BASE, version: "2.0.0", preset: "control" }), env = { ASTRO_NO_GLOBAL_CONFIG: "1" };
    updateConfigKnobs(path, { "run.maxRoundsPerTurn": "100", "team.sessionBudgetUsd": "10" }, { env });
    updateConfigKnobs(path, { preset: "default" }, { env });
    expect(loadConfigRaw(path)).toMatchObject({ preset: "default", run: { maxRoundsPerTurn: 100 }, team: { sessionBudgetUsd: 10 } }); expect(loadConfig(path).run).toMatchObject({ maxRoundsPerTurn: 100 });
    expect(() => updateConfigKnobs(path, { "run.maxRoundsPerTurn": "200" }, { env })).toThrow(/"control"/);
    updateConfigKnobs(path, { preset: "control" }, { env });
    updateConfigKnobs(path, { "run.maxRoundsPerTurn": "200" }, { env }); expect(loadConfigRaw(path).run).toMatchObject({ maxRoundsPerTurn: 200 });
  });

  test("ASTRO_NO_GLOBAL_CONFIG=1 disables global ceiling validation", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-global-edit-off-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ run: { maxRoundsPerTurn: 200 } }));
    const path = writeProject({ ...BASE, preset: "control" });
    updateConfigKnobs(path, { "run.maxRoundsPerTurn": "500" }, { env: { ASTRO_HOME: home, ASTRO_NO_GLOBAL_CONFIG: "1" } });
    expect(loadConfig(path).run).toMatchObject({ maxRoundsPerTurn: 500 });
  });
});
