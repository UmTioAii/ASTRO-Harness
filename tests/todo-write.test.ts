import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/core/app";
import { validateManifest } from "../src/sdk/tool";
import { ToolExecutor } from "../src/tools/executor";
import {
  MAX_TODO_CONTENT_LENGTH,
  MAX_TODO_ITEMS,
  TodoPlanStore,
  createTodoWriteTool,
} from "../src/tools/todo-write";
import type { ToolResult } from "../src/tools/types";
import { testEnv } from "./setup";

const SECRET = ["s", "k", "-"].join("") + "live-todo-secret-987654";
const MARKER = "ITEM-NAO-PODE-IR-PARA-O-AUDIT";

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "astro-todo-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const store = new TodoPlanStore();
  const tool = createTodoWriteTool({ audit, store });
  return { tool, audit, store, cwd, ctx: (run = "r1") => ({ cwd, run, agent: "planner" }) };
}

type Plan = {
  total: number;
  pending: number;
  in_progress: number;
  done: number;
  items: Array<{ content: string; status: string }>;
};

const planOf = (result: ToolResult): Plan => JSON.parse(result.output) as Plan;
const item = (content: string, status = "pending") => ({ content, status });

describe("todo_write manifesto (F-17, #539)", () => {
  test("declara estado efêmero: não escreve arquivo nem rede", () => {
    const { tool } = setup();
    expect(tool.manifest.name).toBe("todo_write");
    expect(validateManifest(tool.manifest)).toEqual(tool.manifest);
    expect(tool.manifest.sideEffects).toBe("none");
    expect(tool.manifest.class).toBe("read_common");
    expect(tool.manifest.permission).toBe("read");
    expect(tool.manifest.idempotent).toBe(true);
    expect(tool.manifest.retryable).toBe(true);
  });
});

describe("todo_write define, substitui e limpa", () => {
  test("define o plano e devolve a lista compacta com contagens", async () => {
    const { tool, store, ctx } = setup();
    const result = await tool.execute({ items: [item("ler o código", "done"), item("escrever o teste", "in_progress")] }, ctx());
    expect(result.isError).not.toBe(true);
    expect(planOf(result)).toEqual({
      total: 2, pending: 0, in_progress: 1, done: 1,
      items: [
        { content: "ler o código", status: "done" },
        { content: "escrever o teste", status: "in_progress" },
      ],
    });
    expect(store.get("r1")).toEqual([
      { content: "ler o código", status: "done" },
      { content: "escrever o teste", status: "in_progress" },
    ]);
  });

  test("a segunda chamada substitui o plano, não acumula", async () => {
    const { tool, store, ctx } = setup();
    await tool.execute({ items: [item("a"), item("b")] }, ctx());
    const replaced = await tool.execute({ items: [item("b", "done")] }, ctx());
    expect(planOf(replaced)).toEqual({
      total: 1, pending: 0, in_progress: 0, done: 1,
      items: [{ content: "b", status: "done" }],
    });
    expect(store.get("r1")).toHaveLength(1);
  });

  test("items: [] limpa o plano e audita contagens zeradas", async () => {
    const { tool, store, audit, ctx } = setup();
    await tool.execute({ items: [item("a")] }, ctx());
    const cleared = await tool.execute({ items: [] }, ctx());
    expect(planOf(cleared)).toEqual({ total: 0, pending: 0, in_progress: 0, done: 0, items: [] });
    expect(store.get("r1")).toHaveLength(0);
    const last = audit.readAll().filter((event) => event.tipo === "todo.updated").at(-1);
    expect(last?.payload).toEqual({ total: 0, pending: 0, in_progress: 0, done: 0 });
  });

  test("o plano sobrevive entre chamadas do mesmo run e não vaza para outro run", async () => {
    const { tool, ctx } = setup();
    await tool.execute({ items: [item("plano do run A")] }, ctx("run-a"));
    const other = await tool.execute({ items: [item("plano do run B")] }, ctx("run-b"));
    expect(planOf(other).items.map((entry) => entry.content)).toEqual(["plano do run B"]);
    expect((await tool.execute({ items: [item("plano do run A", "done")] }, ctx("run-a"))).output).not.toContain("run B");
  });
});

describe("todo_write validação estrita (nada muda no erro)", () => {
  test("aceita o teto de 50 itens e recusa 51 sem tocar no plano anterior", async () => {
    const { tool, store, ctx } = setup();
    const full = Array.from({ length: MAX_TODO_ITEMS }, (_v, index) => item(`tarefa ${index}`));
    expect((await tool.execute({ items: full }, ctx())).isError).not.toBe(true);
    const over = await tool.execute({ items: [...full, item("excedente")] }, ctx());
    expect(over).toMatchObject({ isError: true, code: "invalid_input" });
    expect(store.get("r1")).toHaveLength(MAX_TODO_ITEMS);
  });

  test("status desconhecido, content vazio e content acima do teto viram erro tipado", async () => {
    const { tool, store, ctx } = setup();
    await tool.execute({ items: [item("original")] }, ctx());
    const cases: unknown[] = [
      { items: [item("x", "blocked")] },
      { items: [item("   ")] },
      { items: [{ content: "sem status" }] },
      { items: [{ status: "pending" }] },
      { items: [item("x".repeat(MAX_TODO_CONTENT_LENGTH + 1))] },
    ];
    for (const input of cases) {
      const result = await tool.execute(input, ctx());
      expect(result).toMatchObject({ isError: true, code: "invalid_input" });
    }
    expect(store.get("r1")).toEqual([{ content: "original", status: "pending" }]);
  });

  test("aceita exatamente o teto de caracteres", async () => {
    const { tool, ctx } = setup();
    const result = await tool.execute({ items: [item("y".repeat(MAX_TODO_CONTENT_LENGTH))] }, ctx());
    expect(result.isError).not.toBe(true);
    expect(planOf(result).items[0]?.content).toHaveLength(MAX_TODO_CONTENT_LENGTH);
  });

  test("content duplicado é recusado", async () => {
    const { tool, ctx } = setup();
    const result = await tool.execute({ items: [item("igual"), item("outro"), item(" igual ")] }, ctx());
    expect(result).toMatchObject({ isError: true, code: "invalid_input" });
  });

  test("entrada malformada nunca lança: sempre resultado tipado", async () => {
    const { tool, ctx } = setup();
    for (const input of [null, "x", [], {}, { items: "x" }, { items: [null] }, { items: [], extra: 1 }]) {
      const result = await tool.execute(input, ctx());
      expect(result).toMatchObject({ isError: true, code: "invalid_input" });
    }
  });
});

describe("todo_write saída redigida e audit sem conteúdo (I-03)", () => {
  test("redige segredo no content devolvido e no plano guardado", async () => {
    const { tool, store, ctx } = setup();
    const result = await tool.execute({ items: [item(`usar a chave ${SECRET}`)] }, ctx());
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain("[REDACTED]");
    expect(store.get("r1")[0]?.content).not.toContain(SECRET);
  });

  test("audit só tem tool.call/tool.result/todo.updated, com contagens e nenhum texto de item", async () => {
    const { tool, audit, cwd } = setup();
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["todo_write"],
      audit,
      approveTool: () => true,
    });
    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      { id: "call-1", name: "todo_write", arguments: JSON.stringify({ items: [item(MARKER, "done")] }) },
    );
    expect(result.isError).not.toBe(true);
    const events = audit.readAll();
    expect(events.map((event) => event.tipo)).toEqual(["tool.call", "todo.updated", "tool.result"]);
    expect(events.find((event) => event.tipo === "todo.updated")?.payload)
      .toEqual({ total: 1, pending: 0, in_progress: 0, done: 1 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(MARKER);
    expect(serialized).not.toContain('"content"');
  });
});

describe("todo_write allowlist (I-01)", () => {
  test("fora de agent.tools não executa; dentro, executa", async () => {
    const { tool, audit, store, cwd } = setup();
    const call = {
      id: "call-1",
      name: "todo_write",
      arguments: JSON.stringify({ items: [item("planejar")] }),
    };
    const denied = new ToolExecutor({ tools: [tool], allow: [], audit, approveTool: () => true });
    expect((await denied.run({ cwd, run: "r1", agent: "planner" }, call)).isError).toBe(true);
    expect(store.get("r1")).toHaveLength(0);

    const allowed = new ToolExecutor({ tools: [tool], allow: ["todo_write"], audit, approveTool: () => true });
    expect((await allowed.run({ cwd, run: "r1", agent: "planner" }, call)).isError).not.toBe(true);
    expect(store.get("r1")).toHaveLength(1);
  });
});

describe("todo_write registrada no run (#539)", () => {
  test("agent.tools: [\"todo_write\"] resolve e executa ponta a ponta", async () => {
    let call = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        call += 1;
        return Response.json(call === 1
          ? {
              choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: {
                name: "todo_write",
                arguments: JSON.stringify({ items: [item(MARKER, "in_progress"), item("fechar", "done")] }),
              } }] } }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }
          : { choices: [{ message: { content: "plano atualizado" } }], usage: { prompt_tokens: 6, completion_tokens: 3 } });
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "astro-todo-app-"));
      const configPath = join(dir, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
        models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "mock/mock-1", maxSteps: 4, tools: ["todo_write"] },
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({
        approveTool: () => true,
        configPath,
        task: "planeje",
        cwd: dir,
        env: testEnv({ TEST_KEY: "test-key" }),
      });
      expect(report.final).toBe("plano atualizado");
      const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
      expect(audit).toContain('"tipo":"todo.updated"');
      expect(audit).not.toContain(MARKER);
    } finally {
      server.stop(true);
    }
  });
});
