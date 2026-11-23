import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import type { AgentEntry, ModelEntry } from "../src/core/registry";
import type { CompletionRequest, CompletionResponse, Provider } from "../src/providers/types";
import { runMultiAgentSession, runSession, type MultiAgentSessionOptions, type SessionOptions } from "../src/core/session";
import { handoffTool } from "../src/tools/handoff";
import { writeFileTool } from "../src/tools/write-file";
import { ToolExecutor } from "../src/tools/executor";
import type { TurnEvent } from "../src/chat/turn-events";

const model: ModelEntry = {
  provider: "openai", id: "gpt-4o-mini", tags: ["writing-code"], context: 128000, status: "active",
  price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false },
};
const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
  content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
});
const dir = (tag: string) => mkdtempSync(join(tmpdir(), `astro-${tag}-`));
const writeCall = (id: string) => ({ id, name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) });
const handoffCall = (id: string) => ({
  id, name: "handoff",
  arguments: JSON.stringify({ to: "coder", task: "t", objective: "o", decisions: [], constraints: [], next_steps: [] }),
});
const roundsOf = (events: readonly TurnEvent[]): number[] =>
  events.flatMap((event) => event.kind === "round.start" ? [event.roundIndex] : []);

/** Sessão single-agent cujo script de respostas é consumido em ordem. */
function singleSetup(script: CompletionResponse[]) {
  const cwd = dir("step-single");
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const requests: CompletionRequest[] = [];
  let i = 0;
  const provider: Provider = {
    complete: async (req) => {
      requests.push(req);
      return script[i++] ?? resp({ content: "fim" });
    },
  };
  const opts: SessionOptions = {
    run: "r1", agent: "default", credentialRef: "K", quotaDomain: "default", cwd,
    provider, model, turnId: "turn-7",
    executor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { opts, requests };
}

describe("round.start no loop single-agent (#508, #600)", () => {
  test("emite antes de cada chamada ao provider, em ordem", async () => {
    const s = singleSetup([resp({ toolCalls: [writeCall("c1")] }), resp({ content: "pronto" })]);
    const events: TurnEvent[] = [];
    const callsSeen: number[] = [];
    s.opts.onTurnEvent = (event) => {
      events.push(event);
      if (event.kind === "round.start") callsSeen.push(s.requests.length);
    };
    const result = await runSession(s.opts, "tarefa");
    expect(result.steps).toBe(2);
    expect(roundsOf(events)).toEqual([1, 2]);
    // cada evento antecede a chamada do seu round: 0 chamadas no round 1, 1 no round 2
    expect(callsSeen).toEqual([0, 1]);
    expect(events.at(-1)).toMatchObject({
      kind: "turn.end", turnId: "turn-7", status: "done", usage: { inputTokens: 20, outputTokens: 10 },
    });
  });

  test("tool.end.resultKey é o toolCallId da mensagem de histórico", async () => {
    const s = singleSetup([resp({ toolCalls: [writeCall("c1")] }), resp({ content: "pronto" })]);
    const events: TurnEvent[] = [];
    s.opts.onTurnEvent = (event) => { events.push(event); };
    const result = await runSession(s.opts, "tarefa");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    const toolCallId = toolMessage?.toolCallId;
    if (toolCallId === undefined) throw new Error("expected tool message");
    const end = events.find((event) => event.kind === "tool.end");
    if (end?.kind !== "tool.end") throw new Error("expected tool.end");
    expect(end.callId).toBe("c1");
    expect(end.resultKey).toBe(toolCallId);
    expect(toolCallId).toBe("c1");
  });

  test("observador async que lança não muda o desfecho do turno", async () => {
    const s = singleSetup([resp({ content: "ok" })]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      s.opts.onTurnEvent = async () => { throw new Error("consumer bug"); };
      expect((await runSession(s.opts, "tarefa")).final).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("turno cancelado termina com turn.end cancelled", async () => {
    const s = singleSetup([resp({ content: "ok" })]);
    const events: TurnEvent[] = [];
    s.opts.onTurnEvent = (event) => { events.push(event); };
    s.opts.signal = AbortSignal.abort();
    await expect(runSession(s.opts, "tarefa")).rejects.toThrow();
    expect(events.map((event) => event.kind)).toEqual(["turn.end"]);
    expect(events[0]).toMatchObject({ status: "cancelled", usage: { inputTokens: 0, outputTokens: 0 } });
  });
});

describe("round.start no loop multi-agent (#508, #600)", () => {
  test("usa o round global", async () => {
    const cwd = dir("step-multi");
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const agents: Record<string, AgentEntry> = {
      planner: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff"] },
      coder: { model: "openai/gpt-4o-mini", maxSteps: 3, tools: ["handoff", "write_file"] },
    };
    const registry = {
      requireAgent: (name: string): AgentEntry => agents[name] ?? (() => { throw new Error(`agent "${name}" não encontrado`); })(),
      getAgent: (name: string): AgentEntry | undefined => agents[name],
    };
    const script = [resp({ toolCalls: [handoffCall("h1")] }), resp({ toolCalls: [writeCall("c1")] }), resp({ content: "fim" })];
    let i = 0;
    const provider: Provider = { complete: async () => script[i++] ?? resp({ content: "fim" }) };
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "K", quotaDomain: "default", cwd, provider, registry, baseModel: model,
      baseExecutor: new ToolExecutor({
        tools: [handoffTool, writeFileTool], allow: ["handoff", "write_file"], audit, permissionMode: "bypass",
      }),
      ledger, audit, baseMaxSteps: 3, entryAgent: "planner",
    };
    const events: TurnEvent[] = [];
    opts.onTurnEvent = (event) => { events.push(event); };
    await runMultiAgentSession(opts, "delegue");
    expect(roundsOf(events)).toEqual([1, 2, 3]);
  });
});
