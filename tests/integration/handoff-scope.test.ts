/**
 * Política de compartilhamento de contexto entre agentes (#551): só o escopo
 * declarado (artefato de handoff / prompt da task) cruza a fronteira — nunca
 * histórico do pai, thoughts ou o prompt cru (só `taskHash`, D-11).
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/core/app";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, removeWorkspace, requestMessages, startMockProvider, writeConfig } from "./helpers";

/** Marcadores únicos: se vazarem para o filho ou para o disco, o teste falha. */
const PARENT_PROMPT = "PAI-RAW-PROMPT-zz9";
const HANDOFF_TASK = "HANDOFF-SCOPE-aa1";
const CHILD_PROMPT = "FILHO-TASK-qq7";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function twoProviderConfig(dir: string, baseUrl: string, agentTools: string[], builderModel = "p2/m1", extra: Record<string, unknown> = {}) {
  return writeConfig(dir, {
    providers: {
      p1: { kind: "openai-compat", baseUrl, credentialRef: "KEY1" },
      p2: { kind: "openai-compat", baseUrl, credentialRef: "KEY2" },
    },
    models: [
      { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      { provider: "p2", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
    ],
    agent: { model: "p1/m1", maxSteps: 8, tools: agentTools, entryAgent: "planner" },
    agents: {
      planner: { model: "p1/m1", maxSteps: 8, tools: agentTools },
      builder: { model: builderModel, maxSteps: 4, tools: [] },
    },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...extra,
  });
}

async function run(dir: string, configPath: string, task: string) {
  const previousMode = process.env.ASTRO_PERMISSION_MODE;
  process.env.ASTRO_PERMISSION_MODE = "bypass";
  try {
    return await runTask({
      configPath,
      task,
      cwd: dir,
      env: testEnv({ KEY1: "key-one", KEY2: "key-two" }),
      permissionMode: "allow-edits",
      approveTool: () => true,
      approveSwap: () => true,
    });
  } finally {
    if (previousMode === undefined) delete process.env.ASTRO_PERMISSION_MODE;
    else process.env.ASTRO_PERMISSION_MODE = previousMode;
  }
}

test("handoff para agent declarado: o receptor recebe só system + artefato, nunca histórico/prompt do pai (#551)", async () => {
  const provider = startMockProvider([
    { toolCalls: [{ name: "handoff", arguments: { to: "builder", task: HANDOFF_TASK, objective: "obj", decisions: ["d1"], constraints: [], next_steps: [] } }] },
    { content: "resposta do builder" },
  ]);
  const dir = newWorkspace("handoff-scope");
  try {
    const configPath = twoProviderConfig(dir, provider.baseUrl, ["handoff"]);
    const report = await run(dir, configPath, `tarefa do pai ${PARENT_PROMPT}`);
    expect(report.final).toBe("resposta do builder");

    // Chamada do receptor (2ª request): só system + artefato de handoff.
    const receiver = requestMessages(provider.state.bodies[1]);
    expect(receiver.length).toBeGreaterThan(0);
    expect(receiver.every((message) => message.role === "system")).toBe(true);
    expect(receiver.some((message) => message.content.includes(HANDOFF_TASK))).toBe(true);
    // Nunca o prompt cru do pai nem thoughts/histórico do emissor:
    expect(receiver.some((message) => message.content.includes(PARENT_PROMPT))).toBe(false);
    expect(receiver.some((message) => message.role === "assistant" || message.role === "tool" || message.role === "user")).toBe(false);

    // Disco: o prompt cru do pai não é persistido em lugar nenhum (D-11).
    for (const file of walk(join(dir, ".astro"))) {
      expect(readFileSync(file, "utf8").includes(PARENT_PROMPT)).toBe(false);
    }
  } finally {
    provider.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);

test("task: o filho delegado recebe só o prompt declarado e nada cru é persistido (#551)", async () => {
  const provider = startMockProvider([
    { toolCalls: [{ name: "task", arguments: { agent: "builder", prompt: CHILD_PROMPT } }] },
    { content: "resposta do filho" },
    { content: "fim do pai" },
  ]);
  const dir = newWorkspace("task-scope");
  try {
    const configPath = twoProviderConfig(dir, provider.baseUrl, ["task"], "p1/m1");
    const report = await run(dir, configPath, `tarefa do pai ${PARENT_PROMPT}`);
    expect(report.final).toBe("fim do pai");

    // Chamada do filho (2ª request): system + user com o prompt declarado, só.
    const child = requestMessages(provider.state.bodies[1]);
    expect(child.map((message) => message.role)).toEqual(["system", "user"]);
    expect(child[1]!.content).toContain(CHILD_PROMPT);
    expect(child.some((message) => message.content.includes(PARENT_PROMPT))).toBe(false);

    // Disco: nem o prompt do pai nem o prompt delegado persistem (só hash).
    for (const file of walk(join(dir, ".astro"))) {
      const text = readFileSync(file, "utf8");
      expect(text.includes(PARENT_PROMPT)).toBe(false);
      expect(text.includes(CHILD_PROMPT)).toBe(false);
    }
    // Audit guarda só o hash do prompt delegado (D-11).
    const audit = readAudit(dir);
    const delegated = audit.events.find((event) => event.tipo === "task.delegated");
    expect(String(delegated?.payload.promptHash)).toMatch(/^[a-f0-9]{16}$/);
    expect(audit.text.includes(CHILD_PROMPT)).toBe(false);
  } finally {
    provider.server.stop(true);
    removeWorkspace(dir);
  }
}, 30000);
