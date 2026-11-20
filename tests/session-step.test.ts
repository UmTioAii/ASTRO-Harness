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
    provider, model,
    executor: new ToolExecutor({ approveTool: () => true, tools: [writeFileTool], allow: ["write_file"], audit }),
    ledger, audit, maxSteps: 5,
  };
  return { opts, requests };
}

describe("onStep no loop single-agent (#508)", () => {
  test("emite antes de cada chamada ao provider, em ordem, com o teto efetivo", async () => {
    const s = singleSetup([resp({ toolCalls: [writeCall("c1")] }), resp({ content: "pronto" })]);
    const events: Array<[number, number]> = [];
    const callsSeen: number[] = [];
    s.opts.onStep = (step, maxSteps) => {
      events.push([step, maxSteps]);
      callsSeen.push(s.requests.length);
    };
    const result = await runSession(s.opts, "tarefa");
    expect(result.steps).toBe(2);
    expect(events).toEqual([[1, 5], [2, 5]]);
    // cada evento antecede a chamada do seu step: 0 chamadas no passo 1, 1 no passo 2
    expect(callsSeen).toEqual([0, 1]);
    expect(s.requests).toHaveLength(2);
  });

  test("teto do passo cai quando o budget escolhe lower_effort (#508)", async () => {
    const s = singleSetup([resp({ toolCalls: [writeCall("c1")] }), resp({ content: "pronto" })]);
    s.opts.maxSteps = 10;
    s.opts.budget = { scope: "use-as-you-go", limitUsd: 0.000001, warnAt: 0.8, onExceed: "ask" };
    s.opts.budgetDecide = () => "lower_effort";
    const events: Array<[number, number]> = [];
    s.opts.onStep = (step, maxSteps) => { events.push([step, maxSteps]); };
    const result = await runSession(s.opts, "tarefa");
    expect(result.steps).toBe(2);
    // passo 1 sem gasto (10/10); o gasto do 1º passo esgota o budget e o
    // lower_effort no passo 2 reduz o teto para 2 + floor(8/2) = 6.
    expect(events).toEqual([[1, 10], [2, 6]]);
  });

  test("usa o maxSteps resolvido da sessão no denominador", async () => {
    const s = singleSetup([resp({ toolCalls: [writeCall("c1")] }), resp({ toolCalls: [writeCall("c2")] })]);
    s.opts.maxSteps = 2;
    const events: Array<[number, number]> = [];
    s.opts.onStep = (step, maxSteps) => { events.push([step, maxSteps]); };
    await runSession(s.opts, "loop").catch(() => undefined);
    expect(events).toEqual([[1, 2], [2, 2]]);
  });
});

describe("onStep no loop multi-agent (#508)", () => {
  test("conta por agente ativo e limita pelo teto global restante", async () => {
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
    const events: Array<[number, number]> = [];
    opts.onStep = (step, maxSteps) => { events.push([step, maxSteps]); };
    await runMultiAgentSession(opts, "delegue");
    // planner: 1/3; coder: 1/2 e 2/2 (teto global 4 já consumiu 1 passo)
    expect(events).toEqual([[1, 3], [1, 2], [2, 2]]);
  });
});
