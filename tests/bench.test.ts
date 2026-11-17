import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchModel, filterModels, formatMarkdown, runBenchmark, type BenchReport } from "../src/eval/bench";
import type { ModelEntry } from "../src/registry";
import type { CompletionResponse, Provider } from "../src/provider/types";

const model = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  provider: "mock",
  id: "bench-model",
  tags: ["writing-code", "fast"],
  context: 128000,
  status: "active",
  ...over,
});

/** Provider mock com delay determinístico para medir latência. */
function delayedProvider(delayMs: number, out = 50): Provider {
  return {
    async complete(): Promise<CompletionResponse> {
      await new Promise((r) => setTimeout(r, delayMs));
      return { content: "x".repeat(out), toolCalls: [], usage: { inputTokens: 100, outputTokens: out } };
    },
  };
}

/** Provider mock que falha em uma chamada específica (1-based). */
function flakyProvider(failOnCall: number, out = 40): Provider {
  let calls = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      calls++;
      if (calls === failOnCall) throw new Error("falha simulada");
      return { content: "x".repeat(out), toolCalls: [], usage: { inputTokens: 100, outputTokens: out } };
    },
  };
}

describe("benchmark de providers (F5-4)", () => {
  test("benchModel mede latência, tokens/s e custo/1k (verificado)", async () => {
    const m = model({
      price: { inputPerM: 1, outputPerM: 2, fonte: "tabela", verificado: true },
    });
    const result = await benchModel(m, () => delayedProvider(5, 40), 1);
    expect(result.model).toBe("mock/bench-model");
    expect(result.runs).toBe(1);
    expect(result.latencyMs.min).toBeGreaterThanOrEqual(5);
    expect(result.latencyMs.p50).toBeGreaterThanOrEqual(result.latencyMs.min);
    expect(result.latencyMs.p95).toBeGreaterThanOrEqual(result.latencyMs.p50);
    expect(result.tokensInAvg).toBe(100);
    expect(result.tokensOutAvg).toBe(40);
    // ~40 tokens por ~5ms+ → tokensPerSec > 0
    expect(result.tokensPerSec).toBeGreaterThan(0);
    // custo/1k out = outputPerM = US$ 2
    expect(result.costPer1kOutUsd).toBe(2);
    // TTFT exige streaming: campo pendente
    expect(result.ttftMs).toBeNull();
  });

  test("custo null quando price não verificado", async () => {
    const m = model({
      price: { inputPerM: 1, outputPerM: 2, fonte: "tabela", verificado: false },
    });
    const result = await benchModel(m, () => delayedProvider(1), 1);
    expect(result.costPer1kOutUsd).toBeNull();
  });

  test("custo null sem price", async () => {
    const result = await benchModel(model(), () => delayedProvider(1), 1);
    expect(result.costPer1kOutUsd).toBeNull();
  });

  test("success rate é 100% quando todos os prompts completam", async () => {
    const result = await benchModel(model(), () => delayedProvider(1), 2);
    expect(result.total).toBe(10);
    expect(result.completed).toBe(10);
    expect(result.successRate).toBe(1);
  });

  test("falha de prompt entra na success rate sem derrubar a suíte", async () => {
    const result = await benchModel(model(), () => flakyProvider(2), 1);
    expect(result.total).toBe(5);
    expect(result.completed).toBe(4);
    expect(result.successRate).toBe(0.8);
    // Média de tokens só sobre as chamadas concluídas.
    expect(result.tokensInAvg).toBe(100);
    expect(result.tokensOutAvg).toBe(40);
  });

  test("falha em todos os prompts propaga o erro do provider", async () => {
    const down: Provider = {
      async complete(): Promise<CompletionResponse> {
        throw new Error("provider fora do ar");
      },
    };
    await expect(benchModel(model(), () => down, 1)).rejects.toThrow("provider fora do ar");
  });

  test("filtro de provider/modelo segue a sintaxe do --models", () => {
    const models = [
      model({ provider: "nvidia", id: "n1" }),
      model({ provider: "openrouter", id: "o1" }),
      model({ provider: "openrouter", id: "o2" }),
    ];
    const ids = (list: ModelEntry[]) => list.map((m) => `${m.provider}/${m.id}`);
    const all = ids(models);
    expect(ids(filterModels(models, "nvidia"))).toEqual(["nvidia/n1"]);
    expect(ids(filterModels(models, "openrouter/o2"))).toEqual(["openrouter/o2"]);
    expect(ids(filterModels(models, " nvidia , openrouter/o2 "))).toEqual(["nvidia/n1", "openrouter/o2"]);
    expect(ids(filterModels(models, ""))).toEqual(all);
    expect(ids(filterModels(models, undefined))).toEqual(all);
    expect(filterModels(models, "sem-match")).toEqual([]);
  });

  test("filtro do CI matrix restringe o bench com mocks", async () => {
    const filter = process.env.BENCH_PROVIDER_FILTER ?? "nvidia";
    const models = [
      model({ provider: "nvidia", id: "bench" }),
      model({ provider: "openrouter", id: "bench" }),
    ];
    const selected = filterModels(models, filter);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((m) => `${m.provider}/${m.id}`.includes(filter))).toBe(true);
    const report = await runBenchmark({
      models: selected,
      runs: 1,
      providerFor: () => delayedProvider(1),
    });
    expect(report.results.length).toBe(selected.length);
    expect(report.results.every((r) => r.successRate === 1)).toBe(true);
  });

  test("runBenchmark grava JSON e Markdown com data", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "astro-bench-"));
    const report = await runBenchmark({
      models: [model()],
      runs: 1,
      outDir,
      providerFor: () => delayedProvider(2),
    });
    const date = report.date;
    expect(existsSync(join(outDir, `bench-${date}.json`))).toBe(true);
    const md = readFileSync(join(outDir, `bench-${date}.md`), "utf8");
    expect(md).toContain("# Benchmark de providers");
    expect(md).toContain("| mock/bench-model");
    expect(md).toContain("n/d"); // custo null → n/d
    const json = JSON.parse(readFileSync(join(outDir, `bench-${date}.json`), "utf8")) as BenchReport;
    expect(json.results).toHaveLength(1);
    expect(json.prompts).toBeGreaterThan(0);
    expect(json.results[0]?.successRate).toBe(1);
  });

  test("formatMarkdown inclui todos os modelos e tags", () => {
    const report: BenchReport = {
      schema: 1, date: "2026-10-23", prompts: 5,
      results: [
        {
          model: "a/1", provider: "a", tags: ["fast"], runs: 1,
          latencyMs: { min: 1, p50: 2, p95: 3, max: 3 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 100,
          costPer1kOutUsd: 1.5, ttftMs: null,
          successRate: 0.8, completed: 4, total: 5,
        },
        {
          model: "b/2", provider: "b", tags: ["reasoning"], runs: 1,
          latencyMs: { min: 1, p50: 2, p95: 3, max: 3 },
          tokensInAvg: 10, tokensOutAvg: 20, tokensPerSec: 50,
          costPer1kOutUsd: null, ttftMs: null,
          successRate: 1, completed: 5, total: 5,
        },
      ],
    };
    const md = formatMarkdown(report);
    expect(md).toContain("| a/1 | fast |");
    expect(md).toContain("| b/2 | reasoning |");
    expect(md).toContain("US$ 1.5000");
    expect(md).toContain("n/d");
    // Success rate por modelo e agregada (completed / total).
    expect(md).toContain("| Modelo | Tags | Sucesso |");
    expect(md).toContain("80% (4/5)");
    expect(md).toContain("100% (5/5)");
    expect(md).toContain("Sucesso agregado: 90% (9/10)");
  });
});