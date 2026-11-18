import { describe, expect, test } from "bun:test";
import { ConfigError, effectiveMaxTurns, validateConfig } from "../src/core/config";

/** Config mínima sem `maxSteps`/`maxTurns`: o preset decide (ou o default) os limites. */
function base() {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", tools: [] as string[] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("preset simple/control (#515)", () => {
  test("preset ausente é control e não muda os limites declarados", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 3;
    raw.run = { maxTurns: 2 };
    const cfg = validateConfig(raw);
    expect(cfg.preset).toBe("control");
    expect(cfg.agent.maxSteps).toBe(3);
    expect(cfg.run?.maxTurns).toBe(2);
  });

  test("sem limites declarados, os dois presets começam em 500", () => {
    for (const preset of ["simple", "control"] as const) {
      const cfg = validateConfig({ ...base(), preset });
      expect(cfg.agent.maxSteps).toBe(500);
      expect(effectiveMaxTurns(cfg)).toBe(500);
    }
  });

  test("simple fixa 500/500 sem declarar limites", () => {
    const cfg = validateConfig({ ...base(), preset: "simple" });
    expect(cfg.preset).toBe("simple");
    expect(cfg.agent.maxSteps).toBe(500);
    expect(effectiveMaxTurns(cfg)).toBe(500);
  });

  test("simple recusa agent.maxSteps diferente de 500 citando preset control", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 12;
    expect(() => validateConfig({ ...raw, preset: "simple" })).toThrow(ConfigError);
    expect(() => validateConfig({ ...raw, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("simple recusa agents.*.maxSteps e run.maxTurns diferentes de 500", () => {
    const withAgent = base() as unknown as Record<string, unknown>;
    withAgent.agents = { coder: { model: "p/m1", maxSteps: 7 } };
    expect(() => validateConfig({ ...withAgent, preset: "simple" })).toThrow(/preset.*control/);

    const withTurns = base() as unknown as Record<string, unknown>;
    withTurns.run = { maxTurns: "unlimited" };
    expect(() => validateConfig({ ...withTurns, preset: "simple" })).toThrow(/preset.*control/);
  });

  test("simple aceita 500 explícito, que é o próprio default", () => {
    const raw = base() as unknown as Record<string, unknown>;
    (raw.agent as Record<string, unknown>).maxSteps = 500;
    raw.run = { maxTurns: 500 };
    expect(validateConfig({ ...raw, preset: "simple" }).agent.maxSteps).toBe(500);
  });

  test("preset desconhecido falha", () => {
    expect(() => validateConfig({ ...base(), preset: "turbo" })).toThrow(ConfigError);
  });
});
