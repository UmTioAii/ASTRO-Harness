import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, validateConfig } from "../src/core/config";
import type { AstroConfig } from "../src/core/config";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import { assertBudgetWindows, isoWeekOf, TeamQuotaError } from "../src/team";
import {
  DEFAULT_MAX_SPAWNS_PER_RUN,
  SpawnLimitError,
  SpawnRegistry,
  spawnLimitFromConfig,
} from "../src/spawn";
import type { ModelEntry } from "../src/core/registry";
import { runSession, type SessionOptions } from "../src/core/session";
import { ToolExecutor } from "../src/tools/executor";
import type { CompletionResponse, Provider } from "../src/providers/types";

/** Config mínima válida (mesma base de tests/config-preset.test.ts). */
function base(): Record<string, unknown> {
  return {
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", tools: [] as string[] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
}

describe("preset control expõe os novos limites (#552)", () => {
  test("control aceita team.sessionBudgetUsd/weekBudgetUsd, spawn.maxActive e agents.maxActive", () => {
    const cfg = validateConfig({
      ...structuredClone(base()),
      preset: "control",
      team: { sessionBudgetUsd: 1.5, weekBudgetUsd: 7 },
      spawn: { maxActive: 3 },
      agents: { maxActive: 2 },
    });
    expect(cfg.team?.sessionBudgetUsd).toBe(1.5);
    expect(cfg.team?.weekBudgetUsd).toBe(7);
    expect(cfg.spawn?.maxActive).toBe(3);
    expect(cfg.maxActive).toBe(2);
  });

  test("Default retains advanced declarations without rewriting them", () => {
    const patches: Record<string, unknown>[] = [{ team: { sessionBudgetUsd: 1 } }, { team: { weekBudgetUsd: 1 } }, { spawn: { maxActive: 3 } }]; for (const patch of patches) expect(validateConfig({ ...structuredClone(base()), preset: "simple", ...patch })).toMatchObject(patch);
    expect(validateConfig({ ...base(), preset: "simple", agents: { maxActive: 2 } }).maxActive).toBe(2);
  });

  test("valores inválidos são rejeitados", () => {
    expect(() => validateConfig({ ...base(), team: { sessionBudgetUsd: -1 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base(), team: { weekBudgetUsd: "5" as unknown as number } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base(), spawn: { maxActive: 0 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base(), spawn: { maxActive: 2.5 } })).toThrow(ConfigError);
  });

  test("chaves desconhecidas em team e spawn são rejeitadas", () => {
    expect(() => validateConfig({ ...base(), team: { foo: 1 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base(), spawn: { foo: true } })).toThrow(ConfigError);
  });
});

describe("assertBudgetWindows (#552)", () => {
  const price = (cost: number) => ({ inputPerM: cost * 1_000_000, outputPerM: 0, fonte: "t", verificado: true });

  function ledgerWith(entries: Array<{ run: string; cost: number; ts?: string }>): Ledger {
    const dir = mkdtempSync(join(tmpdir(), "astro-ctl-"));
    const path = join(dir, "ledger.jsonl");
    const ledger = new Ledger(path, { warn: () => {} });
    for (const e of entries) {
      if (e.ts === undefined) {
        ledger.record(
          { run: e.run, agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0 },
          price(e.cost),
        );
      } else {
        // entrada com ts explícito (janela passada), escrita cru como o ledger lê
        const raw = { schemaVersion: 3, kind: "usage", ts: e.ts, run: e.run, agent: "a", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0, costUsd: e.cost };
        appendFileSync(path, `${JSON.stringify(raw)}\n`);
      }
    }
    return ledger;
  }

  function capture(fn: () => void): TeamQuotaError {
    try {
      fn();
      throw new Error("esperava TeamQuotaError");
    } catch (error) {
      if (error instanceof TeamQuotaError) return error;
      throw error;
    }
  }

  const NOW = new Date("2026-11-19T12:00:00.000Z"); // quinta-feira, semana ISO 47 de 2026

  test("janela de sessão soma só o run corrente", () => {
    const ledger = ledgerWith([{ run: "r1", cost: 6 }, { run: "r2", cost: 100 }]);
    expect(() => assertBudgetWindows(ledger, { sessionBudgetUsd: 10 }, "r1", NOW)).not.toThrow();
    const err = capture(() => assertBudgetWindows(ledger, { sessionBudgetUsd: 5 }, "r1", NOW));
    expect(err).toBeInstanceOf(TeamQuotaError);
    expect(err.message).toContain("sessão");
    expect(err.message).toContain("r1");
  });

  test("janela semanal (ISO-8601) ignora semana anterior", () => {
    const ledger = ledgerWith([
      { run: "r1", cost: 6, ts: "2026-11-18T10:00:00.000Z" }, // mesma semana ISO 47
      { run: "r1", cost: 100, ts: "2026-11-01T10:00:00.000Z" }, // semana ISO 44
    ]);
    expect(() => assertBudgetWindows(ledger, { weekBudgetUsd: 10 }, "r1", NOW)).not.toThrow();
    const err = capture(() => assertBudgetWindows(ledger, { weekBudgetUsd: 5 }, "r1", NOW));
    expect(err.message).toContain("semana");
  });

  test("fronteira de semana ISO: domingo (W46) não conta na quinta seguinte (W47)", () => {
    const ledger = ledgerWith([
      { run: "r1", cost: 100, ts: "2026-11-15T23:59:59.000Z" }, // domingo, ISO 2026-W46
    ]);
    // NOW = 2026-11-19 (quinta, ISO 2026-W47): a janela semanal já reiniciou na segunda
    expect(() => assertBudgetWindows(ledger, { weekBudgetUsd: 10 }, "r1", NOW)).not.toThrow();
  });

  test("segunda-feira (W47) entra na semana corrente e o rótulo ISO aparece na mensagem", () => {
    const ledger = ledgerWith([
      { run: "r1", cost: 6, ts: "2026-11-16T00:00:00.000Z" }, // segunda, ISO 2026-W47
    ]);
    const err = capture(() => assertBudgetWindows(ledger, { weekBudgetUsd: 5 }, "r1", NOW));
    expect(err.message).toContain("2026-W47");
  });

  test("janela mensal (project) ignora mês anterior", () => {
    const ledger = ledgerWith([
      { run: "r1", cost: 6, ts: "2026-11-18T10:00:00.000Z" },
      { run: "r1", cost: 100, ts: "2026-10-15T10:00:00.000Z" },
    ]);
    expect(() => assertBudgetWindows(ledger, { projectBudgetUsd: 10 }, "r1", NOW)).not.toThrow();
    const err = capture(() => assertBudgetWindows(ledger, { projectBudgetUsd: 5 }, "r1", NOW));
    expect(err.message).toContain("mensal");
  });

  test("sem limites declarados não bloqueia", () => {
    const ledger = ledgerWith([{ run: "r1", cost: 999 }]);
    expect(() => assertBudgetWindows(ledger, {}, "r1", NOW)).not.toThrow();
  });
});

describe("isoWeekOf (#552)", () => {
  test("rótulos ISO-8601: fronteira de semana e virada de ano", () => {
    expect(isoWeekOf("2026-11-19T12:00:00.000Z")).toBe("2026-W47"); // quinta
    expect(isoWeekOf("2026-11-15T23:59:59.000Z")).toBe("2026-W46"); // domingo anterior
    expect(isoWeekOf("2026-11-16T00:00:00.000Z")).toBe("2026-W47"); // segunda, virada de semana
    expect(isoWeekOf("2026-01-01T12:00:00.000Z")).toBe("2026-W01"); // quinta, semana 1
    expect(isoWeekOf("2025-12-29T12:00:00.000Z")).toBe("2026-W01"); // virada de ano
    expect(isoWeekOf("2021-01-01T12:00:00.000Z")).toBe("2020-W53"); // ano com 53 semanas
    expect(isoWeekOf("2027-01-01T12:00:00.000Z")).toBe("2026-W53"); // virada para 2027
  });
});

describe("spawn.maxActive (#552)", () => {
  const spawned = (id: string) => ({
    agent_id: id,
    parent_agent_id: "orchestrator",
    candidate: { model: "p/m1", tags: ["writing-code"], efficiency: 1, estimated_cost_max_usd: null },
    tools: [] as string[],
    maxRounds: 5,
    maxTurns: 1,
    instructions: "tarefa",
    reason: "teste",
    createdAt: 1,
  });

  test("registry com limite rejeita o spawn extra (fail-closed no próprio registro)", () => {
    const reg = new SpawnRegistry({ limit: 2 });
    reg.add(spawned("sub-1"));
    reg.add(spawned("sub-2"));
    expect(() => reg.add(spawned("sub-3"))).toThrow(SpawnLimitError);
    expect(reg.size).toBe(2);
  });

  test("spawnLimitFromConfig: default 8, maxActive declarado e clamp no teto", () => {
    const cfgDefault = validateConfig(structuredClone(base())) as AstroConfig;
    expect(spawnLimitFromConfig(cfgDefault)).toBe(DEFAULT_MAX_SPAWNS_PER_RUN);
    const cfg3 = validateConfig({ ...structuredClone(base()), preset: "control", spawn: { maxActive: 3 } }) as AstroConfig;
    expect(spawnLimitFromConfig(cfg3)).toBe(3);
    const cfg99 = validateConfig({ ...structuredClone(base()), preset: "control", spawn: { maxActive: 99 } }) as AstroConfig;
    expect(spawnLimitFromConfig(cfg99)).toBe(DEFAULT_MAX_SPAWNS_PER_RUN);
  });
});

describe("runSession com budget de sessão (#552)", () => {
  const model: ModelEntry = {
    provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  };

  test("budget da sessão excedido bloqueia o provider antes da chamada", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-ctl-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"), { warn: () => {} });
    // run "r1" já gastou US$ 10 (1 token in com inputPerM = 10_000_000)
    ledger.record(
      { run: "r1", agent: "coder", provider: "p", model: "m", credentialRef: "K", quotaDomain: "d", tokensIn: 1, tokensOut: 0 },
      { inputPerM: 10_000_000, outputPerM: 0, fonte: "t", verificado: true },
    );

    let calls = 0;
    const provider: Provider = {
      complete: async (): Promise<CompletionResponse> => {
        calls++;
        return { content: "x", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const opts: SessionOptions = {
      run: "r1", agent: "coder", credentialRef: "K", quotaDomain: "d",
      cwd, provider, model,
      executor: new ToolExecutor({ tools: [], allow: [], audit }),
      ledger, audit, maxSteps: 3,
      teamLimits: { sessionBudgetUsd: 10 },
    };

    const err = await runSession(opts, "tarefa").then(() => null, (e) => e as TeamQuotaError);
    expect(err!).toBeInstanceOf(TeamQuotaError);
    expect(err!.message).toContain("sessão");
    expect(calls).toBe(0);
  });
});
