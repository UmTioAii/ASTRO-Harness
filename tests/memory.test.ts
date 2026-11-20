import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/core/config";
import { runTask } from "../src/core/app";
import { DEFAULT_MEMORY_MAX_CHARS, loadMemory, memoryPrompt, memoryReport } from "../src/memory";
import { parseCommand } from "../src/chat/commands";
import { ToolExecutor } from "../src/tools/executor";
import {
  MEMORY_INVALID_INPUT,
  MEMORY_PATH_DENIED,
  createMemoryWriteTool,
} from "../src/tools/memory-write";
import { testEnv } from "./setup";

const SECRET = ["s", "k", "-"].join("") + "live-memory-secret-987654";
const MARKER = /\[\.\.\. mem\u00f3ria truncada: \d+ bytes omitidos \.\.\.\]/;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** cwd com `.astro/` pronto; ASTRO_HOME isolado por caso. */
function project() {
  const cwd = tmp("astro-memory-");
  mkdirSync(join(cwd, ".astro"), { recursive: true });
  const home = tmp("astro-memory-home-");
  return { cwd, home, env: testEnv({ ASTRO_HOME: home }) };
}

function writeProjectMemory(cwd: string, text: string): string {
  const path = join(cwd, ".astro", "memory.md");
  writeFileSync(path, text, "utf8");
  return path;
}

function writeGlobalMemory(home: string, text: string): string {
  const path = join(home, "memory.md");
  writeFileSync(path, text, "utf8");
  return path;
}

function auditEvents(path: string): Array<{ tipo: string; payload: Record<string, unknown> }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> });
}

describe("mem\u00f3ria: inje\u00e7\u00e3o no system prompt (#532)", () => {
  test("global vem antes de project, sob o heading Memory", () => {
    const { cwd, home, env } = project();
    writeGlobalMemory(home, "## Global\n\nfale portugues\n");
    writeProjectMemory(cwd, "## Projeto\n\nuse bun\n");

    const snapshot = loadMemory({ cwd, env });
    const prompt = memoryPrompt(snapshot);

    expect(prompt).toBeDefined();
    expect(prompt!).toContain("## Memory");
    expect(prompt!.indexOf("fale portugues")).toBeGreaterThan(-1);
    expect(prompt!.indexOf("use bun")).toBeGreaterThan(prompt!.indexOf("fale portugues"));
    expect(prompt!).toContain(join(home, "memory.md"));
    expect(prompt!).toContain(join(cwd, ".astro", "memory.md"));
  });

  test("arquivo ausente n\u00e3o gera se\u00e7\u00e3o nem erro", () => {
    const { cwd, env } = project();
    const snapshot = loadMemory({ cwd, env });
    expect(snapshot.blocks).toEqual([]);
    expect(memoryPrompt(snapshot)).toBeUndefined();
    expect(snapshot.warnings).toEqual([]);
  });

  test("memory.maxChars default \u00e9 8000 e o valor declarado vale", () => {
    expect(DEFAULT_MEMORY_MAX_CHARS).toBe(8000);
    const base = {
      providers: { p: { kind: "openai-compat", baseUrl: "https://api.example/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 4096 }],
      agent: { model: "p/m1", maxSteps: 3, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    };
    expect(validateConfig({ ...base, memory: { maxChars: 1200 } }).memory).toEqual({ maxChars: 1200 });
    expect(validateConfig(structuredClone(base)).memory).toBeUndefined();
    expect(() => validateConfig({ ...base, memory: { maxChars: 0 } })).toThrow(/memory\.maxChars/);
  });

  test("cap trunca na fronteira de se\u00e7\u00e3o e audita memory.truncated com bytes", () => {
    const { cwd, env } = project();
    const big = "z".repeat(400);
    writeProjectMemory(cwd, `## Curta\n\naaaa\n\n## Longa\n\n${big}\n`);
    const auditPath = join(cwd, "audit.jsonl");
    const audit = new Auditor(auditPath);

    const snapshot = loadMemory({ cwd, env, maxChars: 400, audit, run: "r1", agent: "default" });
    const prompt = memoryPrompt(snapshot)!;

    expect(prompt).toContain("## Curta");
    expect(prompt).toContain("aaaa");
    expect(prompt).not.toContain("## Longa");
    expect(prompt).not.toContain("zzzz");
    expect(prompt).toMatch(MARKER);
    expect(prompt.length).toBeLessThanOrEqual(400);
    expect(snapshot.remainingChars).toBeGreaterThanOrEqual(0);
    expect(snapshot.usedChars).toBe(prompt.length);

    const truncated = auditEvents(auditPath).filter((event) => event.tipo === "memory.truncated");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.payload.scope).toBe("project");
    expect(truncated[0]!.payload.bytes as number).toBeGreaterThan(400);
    expect(truncated[0]!.payload.maxChars).toBe(400);
  });

  test("linha com forma de segredo nunca chega ao prompt", () => {
    const { cwd, env } = project();
    writeProjectMemory(cwd, `## Deploy\n\nTOKEN=${SECRET}\nrode o deploy\n`);

    const prompt = memoryPrompt(loadMemory({ cwd, env }))!;
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).toContain("rode o deploy");
  });

  test("arquivo ileg\u00edvel avisa uma vez e o run segue sem mem\u00f3ria", () => {
    const { cwd, env } = project();
    mkdirSync(join(cwd, ".astro", "memory.md")); // diret\u00f3rio no lugar do arquivo: leitura falha
    const warnings: string[] = [];

    const snapshot = loadMemory({ cwd, env, warn: (message) => warnings.push(message) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("memory.md");
    expect(memoryPrompt(snapshot)).toBeUndefined();
  });

  test("runTask injeta a mem\u00f3ria no system prompt do run", async () => {
    const { cwd, home, env } = project();
    writeGlobalMemory(home, "## Global\n\nresposta curta\n");
    writeProjectMemory(cwd, "## Projeto\n\ntestes com bun\n");
    let system = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages?: Array<{ role: string; content: string }> };
        system = body.messages?.find((message) => message.role === "system")?.content ?? "";
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
        models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "mock/mock-1", maxSteps: 1, tools: [] },
      }));
      const report = await runTask({ configPath, task: "oi", cwd, env: { ...env, TEST_KEY: "test-key" } });
      expect(report.final).toBe("ok");
      expect(system).toContain("## Memory");
      expect(system).toContain("resposta curta");
      expect(system).toContain("testes com bun");
    } finally {
      server.stop(true);
    }
  });
});

describe("memory_write (#532)", () => {
  function setup() {
    const { cwd, home, env } = project();
    const auditPath = join(cwd, "audit.jsonl");
    const audit = new Auditor(auditPath);
    const tool = createMemoryWriteTool({ audit, env });
    return {
      cwd,
      home,
      env,
      audit,
      auditPath,
      tool,
      ctx: (over: Record<string, unknown> = {}) => ({ cwd, run: "r1", agent: "default", ...over }),
    };
  }

  test("manifesto declara escrita confinada como a\u00e7\u00e3o edit", () => {
    const { tool } = setup();
    expect(tool.manifest.name).toBe("memory_write");
    expect(tool.manifest.class).toBe("edit");
    expect(tool.manifest.permission).toBe("write");
    expect(tool.manifest.sideEffects).toBe("filesystem");
    expect(tool.manifest.retryable).toBe(false);
  });

  test("adiciona e depois substitui a se\u00e7\u00e3o; audit n\u00e3o carrega conte\u00fado", async () => {
    const { tool, cwd, ctx, auditPath } = setup();
    const first = await tool.execute({ scope: "project", section: "Convencoes", text: "usar bun" }, ctx());
    expect(first.isError).not.toBe(true);

    const path = join(cwd, ".astro", "memory.md");
    expect(readFileSync(path, "utf8")).toBe("## Convencoes\n\nusar bun\n");

    const second = await tool.execute({ scope: "project", section: "Convencoes", text: "usar bun test" }, ctx());
    expect(second.isError).not.toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content.match(/^## Convencoes$/gm)).toHaveLength(1);
    expect(content).toContain("usar bun test");
    expect(content).not.toContain("usar bun\n");

    const writes = auditEvents(auditPath).filter((event) => event.tipo === "memory.write");
    expect(writes).toHaveLength(2);
    expect(writes[1]!.payload).toEqual({ scope: "project", section: "Convencoes", chars: 13 });
    expect(readFileSync(auditPath, "utf8")).not.toContain("usar bun");
  });

  test("scope global escreve em $ASTRO_HOME/memory.md", async () => {
    const { tool, home, ctx } = setup();
    const result = await tool.execute({ scope: "global", section: "Global", text: "sem emoji" }, ctx());
    expect(result.isError).not.toBe(true);
    expect(readFileSync(join(home, "memory.md"), "utf8")).toContain("sem emoji");
  });

  test("entrada inv\u00e1lida \u00e9 erro tipado e n\u00e3o muda arquivo", async () => {
    const { tool, cwd, ctx } = setup();
    for (const input of [
      {},
      { scope: "other", section: "a", text: "b" },
      { scope: "project", section: "", text: "b" },
      { scope: "project", section: "a\n## b", text: "b" },
      { scope: "project", section: "a", text: "" },
      { scope: "project", section: "a", text: "b", path: ".astro/memory.md" },
    ]) {
      const result = await tool.execute(input, ctx());
      expect(result.isError).toBe(true);
      expect(result.code).toBe(MEMORY_INVALID_INPUT);
    }
    expect(() => readFileSync(join(cwd, ".astro", "memory.md"), "utf8")).toThrow();
  });

  test("confinamento: junction/.astro para fora do cwd \u00e9 recusado", async () => {
    const { cwd, env, ctx } = setup();
    const outside = tmp("astro-memory-outside-");
    // `.astro` sai do cwd por link; o alvo derivado n\u00e3o pode seguir o link.
    rmSync(join(cwd, ".astro"), { recursive: true, force: true });
    symlinkSync(outside, join(cwd, ".astro"), process.platform === "win32" ? "junction" : "dir");
    const tool = createMemoryWriteTool({ audit: new Auditor(join(cwd, "audit.jsonl")), env });

    const result = await tool.execute({ scope: "project", section: "x", text: "y" }, ctx());

    expect(result.isError).toBe(true);
    expect(result.code).toBe(MEMORY_PATH_DENIED);
    expect(() => readFileSync(join(outside, "memory.md"), "utf8")).toThrow();
  });

  test("confinamento: protectedPaths nunca s\u00e3o sobrescritos", async () => {
    const { tool, cwd, ctx } = setup();
    const protectedPath = join(cwd, ".astro", "memory.md");
    const result = await tool.execute({ scope: "project", section: "x", text: "y" }, ctx({ protectedPaths: [protectedPath] }));
    expect(result.isError).toBe(true);
    expect(result.code).toBe(MEMORY_PATH_DENIED);
    expect(() => readFileSync(protectedPath, "utf8")).toThrow();
  });

  test("modo ask pede aprova\u00e7\u00e3o de a\u00e7\u00e3o edit antes de escrever", async () => {
    const { tool, cwd, audit, ctx } = setup();
    const asked: Array<{ name: string; action: string }> = [];
    const executor = new ToolExecutor({
      tools: [tool],
      allow: ["memory_write"],
      audit,
      permissionMode: "ask",
      approveTool: (request) => {
        asked.push({ name: request.name, action: request.action });
        return false;
      },
    });
    const denied = await executor.run(ctx(), {
      id: "c1",
      name: "memory_write",
      arguments: JSON.stringify({ scope: "project", section: "Convencoes", text: "usar bun" }),
    });
    expect(denied.isError).toBe(true);
    expect(asked).toEqual([{ name: "memory_write", action: "edit" }]);
    expect(() => readFileSync(join(cwd, ".astro", "memory.md"), "utf8")).toThrow();

    const approved = new ToolExecutor({
      tools: [tool],
      allow: ["memory_write"],
      audit,
      permissionMode: "ask",
      approveTool: () => true,
    });
    const written = await approved.run(ctx(), {
      id: "c2",
      name: "memory_write",
      arguments: JSON.stringify({ scope: "project", section: "Convencoes", text: "usar bun" }),
    });
    expect(written.isError).not.toBe(true);
    expect(readFileSync(join(cwd, ".astro", "memory.md"), "utf8")).toContain("usar bun");
  });

  test("isolamento entre projetos: s\u00f3 a mem\u00f3ria do cwd entra no prompt", async () => {
    const a = setup();
    await a.tool.execute({ scope: "project", section: "A", text: "convencao de A" }, a.ctx());

    const b = { cwd: tmp("astro-memory-b-"), env: a.env };
    mkdirSync(join(b.cwd, ".astro"), { recursive: true });
    const promptB = memoryPrompt(loadMemory({ cwd: b.cwd, env: b.env }));
    expect(promptB).toBeUndefined();

    await a.tool.execute({ scope: "global", section: "G", text: "regra global" }, a.ctx());
    const shared = memoryPrompt(loadMemory({ cwd: b.cwd, env: b.env }))!;
    expect(shared).toContain("regra global");
    expect(shared).not.toContain("convencao de A");
  });
});

describe("/memory (#532)", () => {
  test("parser aceita /memory e /memory path", () => {
    expect(parseCommand("/memory")).toEqual({ kind: "memory" });
    expect(parseCommand("/memory path")).toEqual({ kind: "memory", pathsOnly: true });
  });

  test("relat\u00f3rio mostra blocos, caminhos e or\u00e7amento restante", () => {
    const { cwd, home, env } = project();
    writeProjectMemory(cwd, "## Projeto\n\nuse bun\n");
    const snapshot = loadMemory({ cwd, env, maxChars: 500 });

    const full = memoryReport(snapshot);
    expect(full).toContain(join(home, "memory.md"));
    expect(full).toContain(join(cwd, ".astro", "memory.md"));
    expect(full).toContain("use bun");
    expect(full).toContain("restante");

    const paths = memoryReport(snapshot, { pathsOnly: true });
    expect(paths).toContain(join(home, "memory.md"));
    expect(paths).toContain(join(cwd, ".astro", "memory.md"));
    expect(paths).not.toContain("use bun");
  });

  test("sem mem\u00f3ria ainda imprime os caminhos", () => {
    const { cwd, env } = project();
    const text = memoryReport(loadMemory({ cwd, env }));
    expect(text).toContain(join(cwd, ".astro", "memory.md"));
    expect(text).toContain("nenhum bloco");
  });
});

describe("memory_write: integridade do arquivo (review #579)", () => {
  function setup() {
    const { cwd, home, env } = project();
    const auditPath = join(cwd, "audit.jsonl");
    const tool = createMemoryWriteTool({ audit: new Auditor(auditPath), env });
    return { cwd, home, env, auditPath, tool, ctx: { cwd, run: "r1", agent: "default" } };
  }

  const pathOf = (cwd: string) => join(cwd, ".astro", "memory.md");

  test("não re-redige seções intocadas ao substituir outra seção", async () => {
    const { tool, cwd, ctx } = setup();
    const original = "## Notas\n\nnunca coloque token: use o cofre\n";
    writeFileSync(pathOf(cwd), original, "utf8");

    const result = await tool.execute({ scope: "project", section: "Outra", text: "x" }, ctx);
    expect(result.isError).not.toBe(true);

    const content = readFileSync(pathOf(cwd), "utf8");
    expect(content).toContain("nunca coloque token: use o cofre");
    expect(content).not.toContain("[REDACTED]");
    expect(content.startsWith(original)).toBe(true);
  });

  test("grava atomicamente e mantém .bak com o conteúdo anterior (I-16)", async () => {
    const { tool, cwd, ctx } = setup();
    const original = "## Notas\n\nantes\n";
    writeFileSync(pathOf(cwd), original, "utf8");

    const result = await tool.execute({ scope: "project", section: "Notas", text: "depois" }, ctx);
    expect(result.isError).not.toBe(true);

    const dir = join(cwd, ".astro");
    const entries = readdirSync(dir);
    expect(entries.some((name) => name.startsWith("memory.md.") && name.endsWith(".bak"))).toBe(true);
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    const backup = entries.find((name) => name.startsWith("memory.md.") && name.endsWith(".bak"))!;
    expect(readFileSync(join(dir, backup), "utf8")).toBe(original);
    expect(readFileSync(pathOf(cwd), "utf8")).toBe("## Notas\n\ndepois\n");
  });

  test("relata o delta de caracteres do arquivo", async () => {
    const { tool, cwd, ctx } = setup();
    writeFileSync(pathOf(cwd), "## A\n\naaaa\n", "utf8");
    const result = await tool.execute({ scope: "project", section: "A", text: "bb" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain("delta");
    expect(result.output).toMatch(/delta -2/);
  });

  test("redige o texto recebido antes de gravar; segredo não vai a disco, audit nem resultado (I-03)", async () => {
    const { tool, cwd, ctx, auditPath } = setup();
    const result = await tool.execute({ scope: "project", section: "Deploy", text: `TOKEN=${SECRET}` }, ctx);
    expect(result.isError).not.toBe(true);

    const content = readFileSync(pathOf(cwd), "utf8");
    expect(content).not.toContain(SECRET);
    expect(content).toContain("[REDACTED]");
    expect(readFileSync(auditPath, "utf8")).not.toContain(SECRET);
    expect(result.output).not.toContain(SECRET);
  });

  test("substituir a seção do meio mantém as outras duas byte a byte", async () => {
    const { tool, cwd, ctx } = setup();
    const original = "## A\n\nalpha\n\n## B\n\nbeta\n\n## C\n\ngamma\n";
    writeFileSync(pathOf(cwd), original, "utf8");

    const result = await tool.execute({ scope: "project", section: "B", text: "novo" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(readFileSync(pathOf(cwd), "utf8")).toBe("## A\n\nalpha\n\n## B\n\nnovo\n\n## C\n\ngamma\n");
  });

  test("seções duplicadas viram uma só, na primeira posição", async () => {
    const { tool, cwd, ctx } = setup();
    writeFileSync(pathOf(cwd), "## Notas\n\nvelho1\n\n## Outra\n\nx\n\n## Notas\n\nvelho2\n", "utf8");

    const result = await tool.execute({ scope: "project", section: "Notas", text: "novo" }, ctx);
    expect(result.isError).not.toBe(true);
    const content = readFileSync(pathOf(cwd), "utf8");
    expect(content.match(/^## Notas$/gm)).toHaveLength(1);
    expect(content).toBe("## Notas\n\nnovo\n\n## Outra\n\nx\n");
  });

  test("substitui seção cujo corpo tem fence com `## ` dentro (BLOCKER 2)", async () => {
    const { tool, cwd, ctx } = setup();
    const original = [
      "## A", "", "alpha", "",
      "## B", "", "```md", "## nao-e-secao", "texto", "```", "",
      "## C", "", "gamma", "",
    ].join("\n");
    writeFileSync(pathOf(cwd), original, "utf8");

    const result = await tool.execute({ scope: "project", section: "C", text: "novo" }, ctx);
    expect(result.isError).not.toBe(true);
    expect(readFileSync(pathOf(cwd), "utf8")).toBe([
      "## A", "", "alpha", "",
      "## B", "", "```md", "## nao-e-secao", "texto", "```", "",
      "## C", "", "novo", "",
    ].join("\n"));
  });

  test("texto com heading de nível 2 fora de fence é recusado; dentro de fence é aceito", async () => {
    const { tool, ctx } = setup();
    const rejected = await tool.execute({ scope: "project", section: "A", text: "a\n## b" }, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.code).toBe(MEMORY_INVALID_INPUT);

    const fenced = await tool.execute({ scope: "project", section: "A", text: "```\n## b\n```" }, ctx);
    expect(fenced.isError).not.toBe(true);
  });
});

describe("memória: fences, mínimo de budget e hint (review #579)", () => {
  test("cap não corta dentro de um fence", () => {
    const { cwd, env } = project();
    const fence = ["```", ...Array.from({ length: 40 }, (_, i) => `## linha ${i}`), "```"].join("\n");
    writeProjectMemory(cwd, `## Curta\n\naaaa\n\n## Longa\n\n${fence}\n`);

    const prompt = memoryPrompt(loadMemory({ cwd, env, maxChars: 400 }))!;
    expect(prompt).toContain("## Curta");
    expect(prompt).not.toContain("```");
    expect(prompt).toMatch(MARKER);
  });

  test("memory.maxChars tem mínimo de 200 e é aplicado no loader", () => {
    const { cwd, env } = project();
    writeProjectMemory(cwd, "## A\n\naaaa\n");
    expect(loadMemory({ cwd, env, maxChars: 50 }).maxChars).toBe(200);

    const base = {
      providers: { p: { kind: "openai-compat", baseUrl: "https://api.example/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 4096 }],
      agent: { model: "p/m1", maxSteps: 3, tools: [] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    };
    expect(() => validateConfig({ ...base, memory: { maxChars: 100 } })).toThrow(/memory\.maxChars/);
    expect(validateConfig({ ...base, memory: { maxChars: 200 } }).memory).toEqual({ maxChars: 200 });
  });

  test("hint de memory_write é omitido sem a tool na allowlist", () => {
    const { cwd, env } = project();
    writeProjectMemory(cwd, "## A\n\naaaa\n");
    expect(memoryPrompt(loadMemory({ cwd, env }))!).toContain("memory_write");
    const withoutHint = memoryPrompt(loadMemory({ cwd, env, memoryWriteAllowed: false }))!;
    expect(withoutHint).not.toContain("memory_write");
    expect(withoutHint).toContain("## Memory");
  });
});

describe("memória: system prompt de agent nomeado (review #579)", () => {
  test("agents.<nome>.systemPrompt recebe a memória depois do override", async () => {
    const { cwd, env } = project();
    writeProjectMemory(cwd, "## Projeto\n\nregra do projeto\n");
    const systems: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        systems.push(body.messages.find((message) => message.role === "system")?.content ?? "");
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, JSON.stringify({
        providers: { mock: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "TEST_KEY" } },
        models: [{ provider: "mock", id: "mock-1", tags: ["writing-code"], context: 4096 }],
        agent: { model: "mock/mock-1", maxSteps: 2, tools: [], entryAgent: "planner" },
        agents: { maxActive: 1, planner: { model: "mock/mock-1", maxSteps: 2, tools: [], systemPrompt: "OVERRIDE-PLANNER" } },
      }));
      const report = await runTask({ configPath, task: "oi", cwd, env: { ...env, TEST_KEY: "test-key" } });
      expect(report.final).toBe("ok");
      expect(systems[0]).toContain("OVERRIDE-PLANNER");
      expect(systems[0]).toContain("regra do projeto");
    } finally {
      server.stop(true);
    }
  });
});
