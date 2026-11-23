import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/core/config";

/** Config mínima sem `maxSteps`: o preset decide (ou o default) o limite. */
function base() {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", tools: [] as string[] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("preset simple/control (#515)", () => {
  test("omitted preset defaults to Default and preserves a legacy round alias", () => {
    expect(validateConfig(base())).toMatchObject({ preset: "default", run: { maxTurns: 500, maxRoundsPerTurn: 500 } });
    const cfg = validateConfig({ ...base(), agent: { ...base().agent, maxSteps: 3 } });
    expect([cfg.preset, cfg.agent.maxSteps, cfg.run?.maxRoundsPerTurn]).toEqual(["default", 3, 3]);
  });

  test("sem limites declarados, os dois presets começam em 500", () => {
    for (const preset of ["simple", "control"] as const) {
      const cfg = validateConfig({ ...base(), preset });
      expect(cfg.agent.maxSteps).toBe(500);
    }
  });

  test("simple loads as the Default alias with 500 rounds", () => {
    const cfg = validateConfig({ ...base(), preset: "simple" });
    expect(cfg).toMatchObject({ preset: "default", agent: { maxSteps: 500 }, run: { maxTurns: 500, maxRoundsPerTurn: 500 } });
  });

  test("simple aceita um teto mais restrito vindo de outra camada", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 30;
    const cfg = validateConfig({ ...raw, preset: "simple" });
    expect(cfg.agent.maxSteps).toBe(30);
  });

  test("simple recusa agent.maxSteps acima de 500 citando preset control", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 600;
    expect(() => validateConfig({ ...raw, preset: "simple" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...raw, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("simple mantém agents.*.maxSteps restritivo e recusa acima de 500", () => {
    const stricter = base() as unknown as Record<string, unknown>;
    stricter.providers = {
      p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" },
      q: { kind: "openai-compat", baseUrl: "https://q.example/v1", credentialRef: "KEY2" },
    };
    stricter.models = [
      { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "q", id: "m2", tags: ["writing-code"], context: 8192 },
    ];
    stricter.agents = { coder: { model: "q/m2", maxSteps: 30 } };
    const cfg = validateConfig({ ...stricter, preset: "simple" });
    expect(cfg.agents?.coder?.maxSteps).toBe(30);

    const raised = base() as unknown as Record<string, unknown>;
    raised.agents = { coder: { model: "p/m1", maxSteps: 700 } };
    expect(() => validateConfig({ ...raised, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("Default accepts published turn choices and retains advanced declarations", () => {
    const withTurns = { ...base(), version: "2.0.0", preset: "simple" };
    expect(validateConfig({ ...withTurns, run: { maxTurns: 1000 } }).run).toMatchObject({ maxTurns: 1000 });
    // The /config menu offers 250/500/1000, but a hand-written config may use any
    // positive integer (#594 exercises maxTurns: 1).
    expect(validateConfig({ ...withTurns, run: { maxTurns: 600 } }).run).toMatchObject({ maxTurns: 600 });
    expect(validateConfig({ ...withTurns, run: { maxTurns: 100000 } }).run).toMatchObject({ maxTurns: 100000 });
    expect(() => validateConfig({ ...withTurns, run: { maxTurns: 100001 } })).toThrow(/run\.maxTurns.*100000/);
    expect(() => validateConfig({ ...withTurns, run: { maxTurns: 0 } })).toThrow(/run\.maxTurns.*inteiro entre 1 e 100000/);
    expect(validateConfig({ ...base(), run: { maxRoundsPerTurn: 100 } }).run).toMatchObject({ maxRoundsPerTurn: 100 });
  });

  test("simple aceita 500 explícito, que é o próprio teto", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 500;
    expect(validateConfig({ ...raw, preset: "simple" }).agent.maxSteps).toBe(500);
  });

  test("preset desconhecido falha", () => {
    expect(() => validateConfig({ ...base(), preset: "turbo" })).toThrow(ConfigError);
  });

  test("agent de tipo errado não é mascarado pelo preset", () => {
    expect(() => validateConfig({ ...base(), agent: "p/m1", preset: "simple" })).toThrow(/agent/);
    for (const maxSteps of ["25", null, true, 500.5, Infinity]) expect(() => validateConfig({ ...base(), agent: { ...base().agent, maxSteps } })).toThrow(ConfigError);
  });
});
