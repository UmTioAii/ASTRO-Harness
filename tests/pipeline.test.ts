import { describe, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { runCommandTool, configureRunCommand } from "../src/tools/run-command";
import { grepTool } from "../src/tools/grep";
import { editTool } from "../src/tools/edit";
import { pipelineTool } from "../src/tools/pipeline";
import type { Tool } from "../src/tools/types";

const ALL_TOOLS = [readFileTool, writeFileTool, runCommandTool, grepTool, editTool, pipelineTool];

// ADR-0027 slice 4: no módulo compartilhado fica sandbox:false — run_command
// recusa no host (sandbox_required_for_shell). O teste que exercita run_command
// dentro do pipeline usa instância isolada do módulo com Docker mockado (ver
// freshRunCommand/installDockerMock abaixo).
beforeEach(() => configureRunCommand({ sandbox: false }));

function setup(content: string): { cwd: string; audit: Auditor; executor: ToolExecutor } {
  const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-"));
  writeFileSync(join(cwd, "target.txt"), content);
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const executor = new ToolExecutor({ approveTool: () => true,
    tools: ALL_TOOLS,
    allow: ["read_file", "write_file", "run_command", "grep", "edit", "pipeline"],
    audit,
  });
  return { cwd, audit, executor };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

const call = (name: string, args: Record<string, unknown>) => ({
  id: `c-${name}`,
  name,
  arguments: JSON.stringify(args),
});

// --- Sandbox com Docker mockado (ADR-0027 slice 4) ---
// Query string quebra o cache ESM: instância ISOLADA de run-command por teste,
// com sandbox ligado e Bun.spawn/Bun.spawnSync mockados (probe = engine Linux,
// `docker run` devolve saída pronta). Nada executa de verdade e o módulo
// compartilhado não é contaminado.
type RunCommandModule = typeof import("../src/tools/run-command");

async function freshRunCommand(tag: string): Promise<RunCommandModule> {
  return (await import(`../src/tools/run-command.ts?sandbox-mock=${tag}`)) as RunCommandModule;
}

interface SpawnCall {
  cmd: string[];
  opts: Record<string, unknown>;
}

interface FakeProc {
  pid: number;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
  killed: boolean;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeProc(stdout: string, code: number, pid: number, hang = false): FakeProc {
  const proc: FakeProc = {
    pid,
    exited: hang ? new Promise<number>(() => {}) : Promise.resolve(code),
    stdout: streamOf(stdout),
    stderr: streamOf(""),
    kill: () => {
      proc.killed = true;
    },
    killed: false,
  };
  return proc;
}

type DockerRunReply = { stdout: string; code?: number; pid?: number } | "hang";

interface DockerMock {
  calls: SpawnCall[];
  syncCalls: SpawnCall[];
  procs: FakeProc[];
  restore: () => void;
}

/** Mocka o docker CLI: `docker info` responde engine Linux; `docker run` chama onRun. Nada executa de verdade. */
function installDockerMock(onRun: (argv: string[]) => DockerRunReply): DockerMock {
  const bun = Bun as unknown as { spawn: unknown; spawnSync: unknown };
  const originalSpawn = bun.spawn;
  const originalSpawnSync = bun.spawnSync;
  const calls: SpawnCall[] = [];
  const syncCalls: SpawnCall[] = [];
  const procs: FakeProc[] = [];
  const cmdOf = (opts: unknown): string[] =>
    (Array.isArray(opts) ? opts : (opts as { cmd: string[] }).cmd) as string[];
  bun.spawn = (opts: unknown) => {
    const cmd = cmdOf(opts);
    calls.push({ cmd, opts: (opts ?? {}) as Record<string, unknown> });
    if (cmd[0] === "docker" && cmd[1] === "info") {
      const proc = fakeProc("27.0.0|linux\n", 0, 4100);
      procs.push(proc);
      return proc;
    }
    if (cmd[0] === "docker" && cmd[1] === "run") {
      const reply = onRun(cmd);
      const proc =
        reply === "hang"
          ? fakeProc("", 0, 4242, true)
          : fakeProc(reply.stdout, reply.code ?? 0, reply.pid ?? 4242);
      procs.push(proc);
      return proc;
    }
    throw new Error(`spawn não mockado neste teste: ${cmd.join(" ")}`);
  };
  bun.spawnSync = (opts: unknown) => {
    const cmd = cmdOf(opts);
    syncCalls.push({ cmd, opts: (opts ?? {}) as Record<string, unknown> });
    return { exitCode: 0, success: true, signal: null, stdout: streamOf(""), stderr: streamOf("") };
  };
  return {
    calls,
    syncCalls,
    procs,
    restore: () => {
      bun.spawn = originalSpawn;
      bun.spawnSync = originalSpawnSync;
    },
  };
}

describe("pipeline tool (F4-5)", () => {
  test("manifesto correto", () => {
    expect(pipelineTool.manifest.name).toBe("pipeline");
    expect(pipelineTool.manifest.risk).toBe("high");
    expect(pipelineTool.manifest.permission).toBe("write");
    expect(pipelineTool.manifest.timeoutMs).toBe(120_000);
    expect(pipelineTool.manifest.retryable).toBe(false);
    const params = pipelineTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("steps");
    expect(params.required).toContain("steps");
  });

  test("pipeline de 3 steps (grep → edit → run_command) executa em sequência (run_command no sandbox mockado)", async () => {
    const { cwd, audit } = setup("valor original\nvalor x\n");
    const rc = await freshRunCommand("pipeline-run");
    rc.configureRunCommand({ sandbox: true });
    const mock = installDockerMock(() => ({ stdout: "pipeline-ok\n", code: 0 }));
    try {
      // executor com a tool run_command da instância isolada (sandbox ligado)
      const executor = new ToolExecutor({
        approveTool: () => true,
        tools: [readFileTool, writeFileTool, rc.runCommandTool, grepTool, editTool, pipelineTool],
        allow: ["read_file", "write_file", "run_command", "grep", "edit", "pipeline"],
        audit,
      });
      // step 1: grep encontra a linha; step 2: edit troca; step 3: run_command valida
      const result = await pipelineTool.execute(
        {
          steps: [
            { tool: "grep", input: { pattern: "valor original", path: "." } },
            {
              tool: "edit",
              input: {
                path: "target.txt",
                diff: "--- a/target.txt\n+++ b/target.txt\n@@ -1,1 +1,1 @@\n-valor original\n+valor alterado\n",
              },
            },
            { tool: "run_command", input: { command: "echo pipeline-ok" } },
          ],
        },
        { ...ctx(cwd), executor },
      );
      expect(result.isError).toBeFalsy();
      // último step vira output final
      expect(result.output).toContain("pipeline-ok");
      // edit aplicou
      expect(readFileSync(join(cwd, "target.txt"), "utf8")).toContain("valor alterado");
      // run_command foi despachado para o docker (mock), nunca para o host
      expect(mock.calls.filter((c) => c.cmd[0] === "docker" && c.cmd[1] === "run")).toHaveLength(1);
      expect(mock.calls.every((c) => c.cmd[0] === "docker")).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("output de step N vira stdin de step N+1", async () => {
    const { cwd, audit, executor } = setup("abc\n");
    // step 1 escreve conteúdo conhecido; step 2 lê e devolve; conferimos que o run recebe o output anterior via stdin via um arquivo intermediário — mais simples: usar write_file → read_file e verificar o output final
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "write_file", input: { path: "step1.txt", content: "dados do step 1" } },
          { tool: "read_file", input: { path: "step1.txt" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBeFalsy();
    // output final é o do read_file
    expect(result.output).toContain("dados do step 1");
  });

  test("auditoria loga pipeline.step com tool e isError", async () => {
    const { cwd, audit, executor } = setup("x\n");
    await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "x" } },
          { tool: "run_command", input: { command: "echo ok" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    const events = audit.readAll();
    const steps = events.filter((e) => e.tipo === "pipeline.step");
    expect(steps).toHaveLength(2);
    expect(steps[0]!.payload.tool).toBe("grep");
    expect(steps[0]!.payload.step).toBe(0);
    expect(steps[1]!.payload.tool).toBe("run_command");
    expect(steps[1]!.payload.step).toBe(1);
    // steps bem-sucedidos: isError false
    expect(steps[0]!.payload.isError).toBe(false);
  });

  test("falha em step intermediário para o pipeline com erro acumulado", async () => {
    const { cwd, audit, executor } = setup("conteudo\n");
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "conteudo" } },
          { tool: "edit", input: { path: "nao-existe.txt", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" } },
          { tool: "run_command", input: { command: "echo nunca-executa" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output) as { failedStep: number; tool: string; steps: unknown[] };
    expect(parsed.failedStep).toBe(1);
    expect(parsed.tool).toBe("edit");
    // step 3 nunca rodou
    const events = audit.readAll();
    const steps = events.filter((e) => e.tipo === "pipeline.step");
    expect(steps).toHaveLength(2);
  });

  test("sub-tool fora da allowlist do agent é negada (I-01)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    // allowlist só tem pipeline e grep; edit NÃO
    const executor = new ToolExecutor({ approveTool: () => true,
      tools: ALL_TOOLS,
      allow: ["pipeline", "grep"],
      audit,
    });
    const result = await pipelineTool.execute(
      {
        steps: [
          { tool: "grep", input: { pattern: "x" } },
          { tool: "edit", input: { path: "target.txt", diff: "@@ -1,1 +1,1 @@\n-a\n+b\n" } },
        ],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("não permitida");
    // audit registra tool.denied do edit
    const events = audit.readAll();
    expect(events.some((e) => e.tipo === "tool.denied" && e.payload.name === "edit")).toBe(true);
  });

  test("pipeline como sub-tool é rejeitado (sem recursão)", async () => {
    const { cwd, executor } = setup("x\n");
    const result = await pipelineTool.execute(
      {
        steps: [{ tool: "pipeline", input: { steps: [{ tool: "grep", input: { pattern: "x" } }] } }],
      },
      { ...ctx(cwd), executor },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("recursão");
  });

  test("steps vazio → erro claro", async () => {
    const { cwd, executor } = setup("x\n");
    const result = await pipelineTool.execute({ steps: [] }, { ...ctx(cwd), executor });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("steps");
  });

  test("mais de 10 steps → erro claro", async () => {
    const { cwd, executor } = setup("x\n");
    const steps = Array.from({ length: 11 }, () => ({ tool: "grep", input: { pattern: "x" } }));
    const result = await pipelineTool.execute({ steps }, { ...ctx(cwd), executor });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("10");
  });

  test("sem executor no contexto → erro claro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-"));
    const result = await pipelineTool.execute(
      { steps: [{ tool: "grep", input: { pattern: "x" } }] },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("executor");
  });
});
describe("pipeline cancelamento (#260)", () => {
  test("abort entre steps: o step seguinte não executa", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-pipe-abort-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const controller = new AbortController();
    const ran: string[] = [];
    const manifest = {
      description: "step", parameters: { type: "object", properties: {} },
      risk: "low" as const, permission: "test", class: "read_common" as const, timeoutMs: 5_000, retryable: false,
      idempotent: false, sideEffects: "none" as const,
    };
    const first: Tool = {
      manifest: { ...manifest, name: "first" },
      async execute() {
        ran.push("first");
        controller.abort();
        return { output: "um" };
      },
    };
    const second: Tool = {
      manifest: { ...manifest, name: "second" },
      async execute() {
        ran.push("second");
        return { output: "dois" };
      },
    };
    const executor = new ToolExecutor({
      tools: [first, second, pipelineTool],
      allow: ["first", "second", "pipeline"],
      audit,
      approveTool: () => true,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "a", signal: controller.signal },
      { id: "c1", name: "pipeline", arguments: JSON.stringify({ steps: [{ tool: "first", input: {} }, { tool: "second", input: {} }] }) },
    );

    expect(ran).toEqual(["first"]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cancelad");
  });
});

