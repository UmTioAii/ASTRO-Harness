import { describe, expect, test } from "bun:test";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { ChatMessage, CompletionResponse } from "../src/providers/types";
import {
  BackgroundCompactor,
  compactionArtifactPaths,
  type BackgroundCompactionResult,
} from "../src/compaction/background";
import { completeWithCompaction } from "../src/compaction/runtime";

const resp = (content = "ok"): CompletionResponse => ({
  content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
});
const toolResp = (): CompletionResponse => ({
  content: "",
  toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"x\"}" }],
  usage: { inputTokens: 1, outputTokens: 1 },
});
const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "astro-compaction-bg-"));
  return { dir, ledger: new Ledger(join(dir, "ledger.jsonl")), audit: new Auditor(join(dir, "audit.jsonl")) };
}

/** Janela 24k, reserva 16k: limiar 8k. O histórico tem ~7k (pré-aquecimento). */
function history(): ChatMessage[] {
  return [
    { role: "system", content: "SYS" },
    user("a".repeat(12_000)),
    assistant("b".repeat(12_000)),
    user("c".repeat(4_000)),
  ];
}

/** Empurra o contexto para ~9k, acima do limiar de 8k. */
function overTrigger(messages: ChatMessage[]): ChatMessage[] {
  messages.push({ role: "assistant", content: "",
    toolCalls: [{ id: "c1", name: "read_file", arguments: "{\"path\":\"x\"}" }] });
  messages.push({ role: "tool", toolCallId: "c1", content: "d".repeat(8_000) });
  return messages;
}

function options(ledger: Ledger, audit: Auditor, background: BackgroundCompactor) {
  return {
    ledger, audit, run: "r1", agent: () => "a", window: () => 24_000,
    provider: () => "p", model: () => "m", compaction: { buffer: null }, background,
  };
}

function done(text: string): BackgroundCompactionResult {
  return {
    artifact: { schemaVersion: 1, run: "r1", active: "", blocked: [], nextMove: "", relevantFiles: [], importantContext: text },
    reduction: 1, originalTokens: 1, returnedTokens: 1, olderCount: 1, recentStart: 3,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("compactação em background (CMP-9)", () => {
  test("próximo turno aplica o artefato pronto sem compactar inline", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();
    let summaries = 0;

    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => toolResp(),
      summarize: async () => { summaries++; return "BG"; },
    });
    await background.drain();
    expect(summaries).toBe(1);

    overTrigger(messages);
    let seen: readonly ChatMessage[] = [];
    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "INLINE"; },
    });

    expect(summaries).toBe(1);
    expect(seen[1]!.content).toContain("CompactionArtifactV1");
    expect(seen[1]!.content).toContain("BG");
    expect(audit.readAll().find((event) => event.tipo === "compaction.applied")?.payload)
      .toMatchObject({ reason: "trigger", background: true });
    await background.close();
  });

  test("resultado não pronto cai na compactação inline e não trava o turno", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const gate = deferred<string>();
    const messages = history();
    let summaries = 0;

    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => toolResp(),
      summarize: async () => { summaries++; return gate.promise; },
    });
    overTrigger(messages);

    let seen: readonly ChatMessage[] = [];
    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async (current) => { seen = current; return resp("ok"); },
      summarize: async () => { summaries++; return "INLINE"; },
    });
    expect(summaries).toBe(2);
    expect(seen[1]!.content).toContain("INLINE");

    // close aguarda a tarefa em voo: o processo sai limpo.
    const closing = background.close();
    gate.resolve("BG");
    await closing;
  });

  test("turnos concorrentes não leem artefato parcial e a fila é limitada", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const gate = deferred<string>();
    let runs = 0;

    background.schedule("a", history(), async () => { runs++; await gate.promise; return done("BG"); });
    background.schedule("a", history(), async () => { runs++; return done("2"); });
    expect(runs).toBe(1);
    expect(background.take("a", history())).toBeUndefined();

    // Turno concorrente não espera o artefato em escrita: segue inline.
    const result = await completeWithCompaction(overTrigger(history()), {
      ...options(ledger, audit, background),
      complete: async () => resp("concorrente"),
      summarize: async () => "INLINE",
    });
    expect(result.content).toBe("concorrente");

    const closing = background.close();
    gate.resolve("BG");
    await closing;
  });

  test("falha em background conta no breaker e o próximo turno retenta inline", async () => {
    const { dir, ledger, audit } = setup();
    const background = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    const messages = history();

    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => toolResp(),
      summarize: async () => { throw new Error("resumo quebrou"); },
    });
    await background.close(); // não rejeita nem gera unhandled rejection

    const failure = ledger.readAllEntries().filter((entry) => entry.kind === "compaction").at(-1);
    expect(failure).toMatchObject({ failure_count: 1 });
    expect(audit.readAll().find((event) => event.tipo === "compaction.failed")?.payload)
      .toMatchObject({ reason: "background" });

    overTrigger(messages);
    await completeWithCompaction(messages, {
      ...options(ledger, audit, background),
      complete: async () => resp("depois"),
      summarize: async () => "INLINE",
    });
    expect(ledger.readAllEntries().filter((entry) => entry.kind === "compaction").at(-1))
      .toMatchObject({ failure_count: 0 });
  });

  test("artefato sobrevive ao restart e só é lido com o marcador de prontidão", async () => {
    const { dir, ledger, audit } = setup();
    const messages = history();
    const first = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    first.schedule("a", messages, async () => done("PERSISTIDO"));
    await first.drain();
    await first.close();

    // Processo novo: mesma pasta, sem estado em memória.
    const second = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    expect(second.take("a", messages)?.artifact.importantContext).toBe("PERSISTIDO");

    // Sem o marcador o arquivo é tratado como parcial (nunca lido).
    const third = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    third.schedule("b", messages, async () => done("PARCIAL"));
    await third.close();
    unlinkSync(compactionArtifactPaths(dir, "r1", "b").marker);
    const fourth = new BackgroundCompactor({ dir, run: "r1", ledger, audit });
    expect(fourth.take("b", messages)).toBeUndefined();
    await fourth.close();
  });
});
