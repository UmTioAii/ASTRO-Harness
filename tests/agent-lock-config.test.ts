import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/core/config";

function cfg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preset: "control",
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "P2_KEY" },
    },
    models: [{ provider: "p1", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p1/m1", maxSteps: 2, tools: [] },
    agents: { planner: { model: "p1/m1" } },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...over,
  };
}

describe("teto de agentes ativos e contas compartilhadas (ADR-0037)", () => {
  test("agents nomeados carregam com uma única conta: contas são compartilhadas até o limite", () => {
    const one = cfg({
      providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" } },
    });
    expect(() => validateConfig(one)).not.toThrow();
  });

  test("duas contas declaradas passam e maxActive fica ausente", () => {
    const parsed = validateConfig(cfg());
    expect(parsed.agents?.planner?.model).toBe("p1/m1");
    expect(parsed.maxActive).toBeUndefined();
  });

  test("credenciais repetidas não barram a config: a conta é compartilhada", () => {
    const shared = cfg({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "SAME_KEY" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "SAME_KEY" },
      },
    });
    expect(() => validateConfig(shared)).not.toThrow();
  });

  test("provider sem credencial conta como conta própria por provider", () => {
    const keyless = cfg({
      providers: {
        local: { kind: "openai-compat", baseUrl: "http://local/v1" },
        other: { kind: "openai-compat", baseUrl: "http://other/v1" },
      },
      models: [{ provider: "local", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "local/m1", maxSteps: 2, tools: [] },
      agents: { planner: { model: "local/m1" } },
    });
    expect(() => validateConfig(keyless)).not.toThrow();
  });

  test("maxActive=2 com duas contas passa", () => {
    const parsed = validateConfig(cfg({ agents: { maxActive: 2, planner: { model: "p1/m1" } } }));
    expect(parsed.maxActive).toBe(2);
  });

  test("maxActive declarado não é mais limitado pelo número de contas", () => {
    const three = cfg({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "P2_KEY" },
        p3: { kind: "openai-compat", baseUrl: "http://p3/v1", credentialRef: "P3_KEY" },
      },
      agents: { maxActive: 4, planner: { model: "p1/m1" } },
    });
    expect(validateConfig(three).maxActive).toBe(4);
  });

  test("maxActive inválido falha na validação da config", () => {
    expect(() => validateConfig(cfg({ agents: { maxActive: 0, planner: { model: "p1/m1" } } }))).toThrow(
      /maxActive/,
    );
    expect(() => validateConfig(cfg({ agents: { maxActive: 2.5, planner: { model: "p1/m1" } } }))).toThrow(
      /maxActive/,
    );
  });

  test("config de agente único continua válida com uma conta", () => {
    const single = cfg({
      providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "P1_KEY" } },
      agents: undefined,
    });
    expect(() => validateConfig(single)).not.toThrow();
  });
});
