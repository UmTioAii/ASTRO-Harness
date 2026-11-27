import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger, LEDGER_SCHEMA_VERSION } from "../src/ledger";
import { ProviderError, type ChatMessage, type CompletionResponse } from "../src/providers/types";
import { compactionState, recordCompactionFailure } from "../src/compaction/breaker";
import { completeWithCompaction, isContextOverflow } from "../src/compaction/runtime";

const resp = (content = "ok"): CompletionResponse => ({
  content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
});
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

/** History that crosses the compaction trigger for a 24k window. */
const bigHistory = (): ChatMessage[] => [
  { role: "system", content: "SYS" },
  user("a".repeat(30_000)),
  assistant("b".repeat(30_000)),
  user("c".repeat(10_000)),
  assistant("d".repeat(8_000)),
];

/** Shared runtime options: a 24k window with no buffer. */
const base = {
  run: "r1", agent: () => "a", window: () => 24_000, provider: () => "p", model: () => "m",
  compaction: { buffer: null },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "astro-compaction-runtime-"));
  return {
    ledger: new Ledger(join(dir, "ledger.jsonl")),
    audit: new Auditor(join(dir, "audit.jsonl")),
    dir,
  };
}

const small: ChatMessage[] = [
  { role: "system", content: "SYS" },
  user("x".repeat(300)), // 75 tokens
];

describe("runtime da compactação (S-17, CMP-6/CMP-7)", () => {
  test("isContextOverflow reconhece rejeição por tamanho e ignora outros erros", () => {
    expect(isContextOverflow(new ProviderError("invalid_request", "maximum context length exceeded"))).toBe(true);
    expect(isContextOverflow(new ProviderError("invalid_request", "prompt is too long: 200000 tokens"))).toBe(true);
    expect(isContextOverflow(new ProviderError("invalid_request", "tool schema inválido"))).toBe(false);
    expect(isContextOverflow(new ProviderError("invalid_request", "model does not support the context caching parameter"))).toBe(false);
    expect(isContextOverflow(new ProviderError("invalid_request", "Input is too long for requested model"))).toBe(true);
    expect(isContextOverflow(new ProviderError("invalid_request", "Request too large"))).toBe(true);
    expect(isContextOverflow(new ProviderError("outage", "maximum context length exceeded"))).toBe(false);
    expect(isContextOverflow(new Error("maximum context length exceeded"))).toBe(false);
  });

  test("abaixo do gatilho não compacta e chama o provider uma vez", async () => {
    const { ledger, audit } = setup();
    let summaries = 0;
    const response = await completeWithCompaction(small, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 1_000, provider: () => "p", model: () => "m",
      compaction: { buffer: 900 },
      complete: async () => resp("ok"),
      summarize: async () => { summaries++; return "s"; },
    });
    expect(response.content).toBe("ok");
    expect(summaries).toBe(0);
  });

  test("dispara quando a estimativa atinge o limiar e grava sucesso no ledger", async () => {
    const { ledger, audit } = setup();
    // janela 24k, reserva 16k → limiar 8k; recente clampado para 6k.
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      user("a".repeat(30_000)),
      assistant("b".repeat(30_000)),
      user("c".repeat(10_000)),
      assistant("d".repeat(8_000)),
    ];
    let seen: readonly ChatMessage[] = [];
    let summaries = 0;
    await completeWithCompaction(messages, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 24_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "resumo"; },
    });

    expect(summaries).toBe(1);
    expect(seen[0]).toEqual({ role: "system", content: "SYS" });
    expect(seen[1]!.content).toContain("CompactionArtifactV1");
    expect(ledger.readAllEntries().filter((e) => e.kind === "compaction")).toHaveLength(1);
    expect(audit.readAll().some((e) => e.tipo === "compaction.applied")).toBe(true);
  });

  test("não repete quando não há histórico anterior para substituir", async () => {
    const { ledger, audit } = setup();
    const messages: ChatMessage[] = [{ role: "system", content: "SYS" }, user("x".repeat(40_000))];
    let summaries = 0;
    let calls = 0;
    await completeWithCompaction(messages, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 24_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      complete: async () => { calls++; return resp("ok"); },
      summarize: async () => { summaries++; return "s"; },
    });
    expect(summaries).toBe(0);
    expect(calls).toBe(1);
    expect(ledger.readAllEntries().some((e) => e.kind === "compaction")).toBe(false);
  });

  test("cancelamento durante o resumo não conta como falha do breaker", async () => {
    const { ledger, audit } = setup();
    const controller = new AbortController();
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      user("a".repeat(30_000)),
      assistant("b".repeat(30_000)),
      user("c".repeat(10_000)),
      assistant("d".repeat(8_000)),
    ];
    const run = completeWithCompaction(messages, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 24_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      signal: controller.signal,
      complete: async () => resp("ok"),
      summarize: async () => {
        controller.abort();
        throw new DOMException("cancelado", "AbortError");
      },
    });
    await expect(run).rejects.toBeDefined();
    expect(ledger.readAllEntries().some((e) => e.kind === "compaction")).toBe(false);
    expect(audit.readAll().some((e) => e.tipo === "compaction.failed")).toBe(false);
  });

  test("rejeição por tamanho compacta e retenta uma única vez", async () => {
    const { ledger, audit } = setup();
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      user("a".repeat(40_000)),
      assistant("b".repeat(40_000)),
      user("c"),
    ];
    let calls = 0;
    const response = await completeWithCompaction(messages, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 128_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      complete: async () => {
        calls++;
        if (calls === 1) throw new ProviderError("invalid_request", "maximum context length exceeded");
        return resp("depois");
      },
      summarize: async () => "resumo",
    });
    expect(response.content).toBe("depois");
    expect(calls).toBe(2);
  });

  test("segunda rejeição por tamanho sobe o erro", async () => {
    const { ledger, audit } = setup();
    const messages: ChatMessage[] = [
      { role: "system", content: "SYS" },
      user("a".repeat(40_000)),
      assistant("b".repeat(40_000)),
      user("c"),
    ];
    let calls = 0;
    const run = completeWithCompaction(messages, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 128_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      complete: async () => {
        calls++;
        throw new ProviderError("invalid_request", "maximum context length exceeded");
      },
      summarize: async () => "resumo",
    });
    await expect(run).rejects.toThrow(/maximum context length/);
    expect(calls).toBe(2);
  });

  test("overflow sem nada para compactar não repete a request", async () => {
    const { ledger, audit } = setup();
    let calls = 0;
    const run = completeWithCompaction([...small], {
      ledger, audit, run: "r1", agent: () => "a", window: () => 128_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      complete: async () => {
        calls++;
        throw new ProviderError("invalid_request", "maximum context length exceeded");
      },
      summarize: async () => "resumo",
    });
    await expect(run).rejects.toThrow(/maximum context length/);
    expect(calls).toBe(1);
  });

  test("contexto já acima da janela compacta mesmo sem projetar abaixo do gatilho", async () => {
    const { ledger, audit } = setup();
    const messages: ChatMessage[] = [
      { role: "system", content: "s".repeat(12_000) }, // 3.000 tokens
      user("u".repeat(88_000)), // 22.000 tokens
      assistant("a".repeat(2_000)), // 500 tokens
    ];
    let summaries = 0;
    let seen: readonly ChatMessage[] = [];
    await completeWithCompaction(messages, {
      ledger, audit, run: "r1", agent: () => "a", window: () => 24_000, provider: () => "p", model: () => "m",
      compaction: { buffer: null },
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "resumo"; },
    });
    expect(summaries).toBe(1);
    expect(seen[1]!.content).toContain("CompactionArtifactV1");
    expect(ledger.readAllEntries().some((entry) => entry.kind === "compaction")).toBe(true);
  });

  test("breaker pausado não bloqueia: compacta sem modelo e segue", async () => {
    const { ledger, audit } = setup();
    for (let index = 0; index < 3; index++) recordCompactionFailure(ledger, "r1", "a");
    const messages = bigHistory();
    let summaries = 0;
    let seen: readonly ChatMessage[] = [];
    const response = await completeWithCompaction(messages, {
      ...base, ledger, audit,
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "s"; },
    });
    // A pausa gateia só o modelo: o contexto é reduzido pelo extrativo.
    expect(response.content).toBe("ok");
    expect(summaries).toBe(0);
    expect(seen[1]!.content).toContain("CompactionArtifactV1");
    expect(audit.readAll().some((e) => e.tipo === "compaction.degraded")).toBe(true);
  });

  test("falha do resumo degrada para o extrativo e nunca interrompe o run", async () => {
    const { ledger, audit } = setup();
    let calls = 0;
    for (let round = 0; round < 4; round++) {
      const messages = bigHistory();
      let seen: readonly ChatMessage[] = [];
      await completeWithCompaction(messages, {
        ...base, ledger, audit,
        compaction: { buffer: null, maxRetries: 0 },
        complete: async (current) => { calls++; seen = current; return resp("ok"); },
        summarize: async () => { throw new ProviderError("auth", "sem credencial"); },
      });
      expect(seen[1]!.content).toContain("CompactionArtifactV1");
    }
    // As 4 rodadas seguiram; o breaker abriu na 3ª e o run continuou.
    expect(calls).toBe(4);
    expect(compactionState(ledger, "r1").paused).toBe(true);
    expect(ledger.readAllEntries().filter((e) => e.kind === "compaction").at(-1))
      .toMatchObject({ failure_count: 3 });
    expect(audit.readAll().find((e) => e.tipo === "compaction.failed")?.payload)
      .toMatchObject({ error: "auth" });
    expect(audit.readAll().filter((e) => e.tipo === "compaction.degraded")).toHaveLength(4);
  });

  test("falha transitória é retentada e o sucesso não conta no breaker", async () => {
    const { ledger, audit } = setup();
    let attempts = 0;
    await completeWithCompaction(bigHistory(), {
      ...base, ledger, audit,
      compaction: { buffer: null, maxRetries: 2, retryBackoffMs: 1 },
      complete: async () => resp("ok"),
      summarize: async () => {
        attempts++;
        if (attempts === 1) throw new ProviderError("network_timeout", "timeout");
        return "resumo";
      },
    });
    expect(attempts).toBe(2);
    expect(compactionState(ledger, "r1").failures).toBe(0);
    expect(audit.readAll().some((e) => e.tipo === "compaction.retry")).toBe(true);
  });

  test("falha determinística não é retentada", async () => {
    const { ledger, audit } = setup();
    let attempts = 0;
    let calls = 0;
    await completeWithCompaction(bigHistory(), {
      ...base, ledger, audit,
      compaction: { buffer: null, maxRetries: 3, retryBackoffMs: 1 },
      complete: async () => { calls++; return resp("ok"); },
      summarize: async () => {
        attempts++;
        throw new ProviderError("invalid_request", "model not found");
      },
    });
    expect(attempts).toBe(1);
    expect(calls).toBe(1);
  });

  test("o modelo volta a ser sondado quando a pausa expira", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-compaction-runtime-"));
    const path = join(dir, "ledger.jsonl");
    // 3 falhas de 10 min atrás: a pausa de 5 min já expirou.
    const entry = { schemaVersion: LEDGER_SCHEMA_VERSION, ts: new Date(Date.now() - 600_000).toISOString(), run: "r1", agent: "a", kind: "compaction", failure_count: 3, manual: false, seq: 0 };
    writeFileSync(path, `${JSON.stringify(entry)}\n`);
    const ledger = new Ledger(path);
    const audit = new Auditor(join(dir, "audit.jsonl"));
    let summaries = 0;
    await completeWithCompaction(bigHistory(), {
      ...base, ledger, audit,
      complete: async () => resp("ok"),
      summarize: async () => { summaries++; return "resumo"; },
    });
    // A pausa expirou: o modelo é sondado de novo e o contador zera.
    expect(summaries).toBe(1);
    expect(compactionState(ledger, "r1").failures).toBe(0);
  });


  test("cancelamento durante o backoff interrompe sem esperar", async () => {
    const { ledger, audit } = setup();
    const controller = new AbortController();
    const started = Date.now();
    const run = completeWithCompaction(bigHistory(), {
      ...base, ledger, audit,
      compaction: { buffer: null, maxRetries: 2, retryBackoffMs: 5_000 },
      signal: controller.signal,
      complete: async () => resp("ok"),
      summarize: async () => { throw new ProviderError("outage", "down"); },
    });
    setTimeout(() => controller.abort(), 20);
    // O abort interrompe o backoff: erro de cancelamento, sem breaker e sem fallback.
    await expect(run).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction")).toHaveLength(0);
    expect(audit.readAll().some((event) => event.tipo === "compaction.degraded")).toBe(false);
  });
});
