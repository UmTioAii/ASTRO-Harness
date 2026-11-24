import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import type { TurnEvent } from "../src/chat/turn-events";
import type { ModelEntry } from "../src/core/registry";
import { runSession, type SessionOptions } from "../src/core/session";
import { Ledger } from "../src/ledger";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/providers/types";
import { ToolExecutor } from "../src/tools/executor";
import { writeFileTool } from "../src/tools/write-file";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (partial: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...partial,
});
const writeCall = (id: string) => ({
  id, name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }),
});

/** Session whose provider scripts are consumed in order; requests are captured for replay checks. */
function setup(script: CompletionResponse[]) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-reasoning-"));
  const auditPath = join(cwd, "audit.jsonl");
  const ledgerPath = join(cwd, "ledger.jsonl");
  const audit = new Auditor(auditPath);
  const ledger = new Ledger(ledgerPath);
  const requests: CompletionRequest[] = [];
  let index = 0;
  const provider: Provider = {
    complete: async (req) => {
      requests.push(req);
      return script[index++] ?? resp({ content: "fim" });
    },
  };
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "K", quotaDomain: "default", cwd,
    provider, model, turnId: "turn-9",
    executor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { auditPath, ledger, ledgerPath, opts, requests };
}

const kinds = (events: readonly TurnEvent[]): string[] => events.map((event) => event.kind);

describe("reasoning on the turn stream (#600)", () => {
  test("emits one sanitized reasoning event before the tools and turn.end (I-03)", async () => {
    const s = setup([
      resp({ reasoning: "primeiro sk-abcdefgh12345678\nsegunda linha", toolCalls: [writeCall("c1")] }),
      resp({ content: "pronto" }),
    ]);
    const events: TurnEvent[] = [];
    s.opts.onTurnEvent = (event) => { events.push(event); };

    await runSession(s.opts, "tarefa");

    expect(kinds(events)).toEqual(["round.start", "reasoning", "tool.start", "tool.end", "round.start", "turn.end"]);
    const reasoning = events[1]!;
    if (reasoning.kind !== "reasoning") throw new Error("expected reasoning");
    expect(reasoning.text).toContain("[REDACTED]");
    expect(reasoning.text).not.toContain("sk-abcdefgh12345678");
    expect(reasoning.text).toContain("\nsegunda linha");
  });

  test("a provider without a reasoning channel emits no reasoning event or placeholder", async () => {
    const s = setup([resp({ content: "ok" })]);
    const events: TurnEvent[] = [];
    s.opts.onTurnEvent = (event) => { events.push(event); };

    await runSession(s.opts, "tarefa");

    expect(kinds(events)).toEqual(["round.start", "turn.end"]);
    expect(events.some((event) => event.kind === "reasoning")).toBe(false);
  });

  test("reasoning is never persisted or replayed and does not change token accounting", async () => {
    const marker = "raciocinio-nao-persistido-9f2c";
    const s = setup([
      resp({ reasoning: marker, toolCalls: [writeCall("c1")], usage: { inputTokens: 10, outputTokens: 42 } }),
      resp({ content: "pronto" }),
    ]);
    const events: TurnEvent[] = [];
    s.opts.onTurnEvent = (event) => { events.push(event); };

    const result = await runSession(s.opts, "tarefa");

    // Runtime-only: no message, no retry payload, no ledger and no audit retain the text.
    expect(JSON.stringify(result.messages)).not.toContain(marker);
    expect(JSON.stringify(s.requests[1]!.messages)).not.toContain(marker);
    expect(readFileSync(s.ledgerPath, "utf8")).not.toContain(marker);
    expect(readFileSync(s.auditPath, "utf8")).not.toContain(marker);
    // Provider tokens already include reasoning; they are not added twice.
    expect(s.ledger.readAll()[0]!.tokensOut).toBe(42);
    const end = events.find((event) => event.kind === "turn.end");
    if (end?.kind !== "turn.end") throw new Error("expected turn.end");
    expect(end.usage.outputTokens).toBe(47); // 42 + the final round's 5
    expect(s.ledger.readAll().reduce((sum, entry) => sum + entry.tokensOut, 0)).toBe(47);
  });
});
