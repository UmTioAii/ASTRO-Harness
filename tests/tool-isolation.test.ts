import { describe, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { writeFileTool } from "../src/tools/write-file";
import { runCommandTool, configureRunCommand } from "../src/tools/run-command";
import type { ToolCall } from "../src/provider/types";
import type { Tool } from "../src/tools/types";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
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

// ADR-0027 slice 4: no módulo compartilhado fica sandbox:false — run_command
// recusa no host (sandbox_required_for_shell). Os testes que exercitam execução
// usam instância isolada do módulo com Docker mockado (ver freshRunCommand abaixo).
beforeEach(() => configureRunCommand({ sandbox: false }));

/** Cria uma tool simples de teste para registro dinâmico. */
function makeTool(name: string): Tool {
  return {
    manifest: {
      name,
      description: `test tool ${name}`,
      parameters: { type: "object", properties: {} },
      risk: "low",
      permission: "test",
      timeoutMs: 1000,
      retryable: false,
      idempotent: false,
      sideEffects: "none",
      class: "read_common",
    },
    async execute() {
      return { output: `${name}-ok` };
    },
  };
}

describe("isolamento de tools por agent (F3-5)", () => {
  test("tool fora da allowlist do agent → erro com nome do agent + tool.denied no audit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Planner só tem read_file; tenta run_command
    const executor = new ToolExecutor({ approveTool: () => true,
      tools: [readFileTool, writeFileTool, runCommandTool],
      allow: ["read_file"], // planner: só read_file
      audit,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      call("run_command", { command: "echo hi" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("run_command");
    expect(result.output).toContain("planner");

    // Auditoria loga tool.denied
    const events = audit.readAll();
    const denied = events.find((e) => e.tipo === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("planner");
    expect(denied!.payload.name).toBe("run_command");
    expect(denied!.payload.reason).toContain("não permitida");
  });

  test("coder com run_command na allowlist → executa ok (sandbox com Docker mockado)", async () => {
    const rc = await freshRunCommand("iso-coder");
    rc.configureRunCommand({ sandbox: true });
    // docker run devolve o argumento do "echo" final do argv
    const mock = installDockerMock((argv) => ({ stdout: `${argv.at(-1)!.replace(/^echo /, "")}\n`, code: 0 }));
    try {
      const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
      const audit = new Auditor(join(cwd, "audit.jsonl"));

      const executor = new ToolExecutor({ approveTool: () => true,
        tools: [readFileTool, writeFileTool, rc.runCommandTool],
        allow: ["read_file", "write_file", "run_command"], // coder: todas
        audit,
      });

      const result = await executor.run(
        { cwd, run: "r1", agent: "coder" },
        call("run_command", { command: "echo hello" }),
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("hello");

      // Sem tool.denied no audit
      const events = audit.readAll();
      expect(events.find((e) => e.tipo === "tool.denied")).toBeUndefined();
      // o comando foi para o container (docker run), não para o host
      expect(mock.calls.filter((c) => c.cmd[0] === "docker" && c.cmd[1] === "run")).toHaveLength(1);
      expect(mock.calls.every((c) => c.cmd[0] === "docker")).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("tool desconhecida também gera tool.denied", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    const executor = new ToolExecutor({ approveTool: () => true,
      tools: [readFileTool],
      allow: ["read_file"],
      audit,
    });

    const result = await executor.run(
      { cwd, run: "r1", agent: "reviewer" },
      call("ghost_tool", {}),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("desconhecida");

    const events = audit.readAll();
    const denied = events.find((e) => e.tipo === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.payload.reason).toContain("desconhecida");
  });

  test("planner tenta run_command → erro; coder usa run_command → ok (cenário multi-agent, sandbox mockado)", async () => {
    const rc = await freshRunCommand("iso-multi");
    rc.configureRunCommand({ sandbox: true });
    const mock = installDockerMock((argv) => ({ stdout: `${argv.at(-1)!.replace(/^echo /, "")}\n`, code: 0 }));
    try {
      const cwd = mkdtempSync(join(tmpdir(), "astro-iso-"));
      const audit = new Auditor(join(cwd, "audit.jsonl"));

      // Dois executores com allowlists diferentes (como runMultiAgentSession cria)
      const plannerExecutor = new ToolExecutor({ approveTool: () => true,
        tools: [readFileTool, writeFileTool, rc.runCommandTool],
        allow: ["read_file"], // planner: só leitura
        audit,
      });
      const coderExecutor = new ToolExecutor({ approveTool: () => true,
        tools: [readFileTool, writeFileTool, rc.runCommandTool],
        allow: ["read_file", "write_file", "run_command"], // coder: todas
        audit,
      });

      // Planner tenta run_command → negado
      const plannerResult = await plannerExecutor.run(
        { cwd, run: "r1", agent: "planner" },
        call("run_command", { command: "echo no" }),
      );
      expect(plannerResult.isError).toBe(true);
      expect(plannerResult.output).toContain("planner");

      // Coder usa run_command → ok
      const coderResult = await coderExecutor.run(
        { cwd, run: "r1", agent: "coder" },
        call("run_command", { command: "echo yes" }),
      );
      expect(coderResult.isError).toBeFalsy();
      expect(coderResult.output).toContain("yes");

      // Audit tem tool.denied do planner e tool.result ok do coder
      const events = audit.readAll();
      const deniedEvents = events.filter((e) => e.tipo === "tool.denied");
      expect(deniedEvents).toHaveLength(1);
      expect(deniedEvents[0].agent).toBe("planner");
      // só o coder chegou no docker (planner foi barrado no gate, antes do spawn)
      expect(mock.calls.filter((c) => c.cmd[0] === "docker" && c.cmd[1] === "run")).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });
});

describe("regressão do tool guard: registro dinâmico e escopo de subagent (S-04, #121)", () => {
  test("(a) tool registrada DEPOIS do executor criado NÃO executa para o mesmo agent: tool.denied no audit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-dyn-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Tool inicial
    const initialTool = makeTool("initial_tool");

    const executor = new ToolExecutor({ approveTool: () => true,
      tools: [initialTool],
      allow: ["initial_tool"],
      audit,
    });

    // Registra uma NOVA tool APÓS criar o executor (simula registro dinâmico)
    const dynamicTool = makeTool("dynamic_tool");
    const executorWithDynamic = new ToolExecutor({ approveTool: () => true,
      tools: [...executor.allTools, dynamicTool],
      allow: [...executor.allow, "dynamic_tool"],
      audit,
    });

    // O executor ORIGINAL (que foi criado ANTES do registro dinâmico)
    // NÃO deve executar a tool dinâmica mesmo que ela esteja na allowlist
    // porque o ToolExecutor não a conhece (não estava no byName map no momento da criação)
    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      call("dynamic_tool", {}),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("desconhecida");

    // Auditoria loga tool.denied
    const events = audit.readAll();
    const denied = events.find((e) => e.tipo === "tool.denied");
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("planner");
    expect(denied!.payload.name).toBe("dynamic_tool");
    expect(denied!.payload.reason).toContain("desconhecida");
  });

  test("(b) tool registrada no executor do subagent fica dentro do allowlist do subagent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sub-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Executor base (orchestrator)
    const baseExecutor = new ToolExecutor({ approveTool: () => true,
      tools: [readFileTool, makeTool("parent_only")],
      allow: ["read_file", "parent_only"],
      audit,
    });

    // Subagent tem seu próprio executor com tool exclusiva
    const subExecutor = new ToolExecutor({ approveTool: () => true,
      tools: [...baseExecutor.allTools, makeTool("sub_only")],
      allow: ["read_file", "sub_only"],
      audit,
    });

    // Subagent consegue executar sua tool exclusiva
    const subResult = await subExecutor.run(
      { cwd, run: "r1", agent: "subagent" },
      call("sub_only", {}),
    );
    expect(subResult.isError).toBeFalsy();
    expect(subResult.output).toContain("sub_only-ok");

    // Subagent NÃO consegue executar a tool exclusiva do parent (não está no allowlist do sub)
    const parentToolResult = await subExecutor.run(
      { cwd, run: "r1", agent: "subagent" },
      call("parent_only", {}),
    );
    expect(parentToolResult.isError).toBe(true);
    expect(parentToolResult.output).toContain("não permitida");

    // Verifica auditoria: tool.denied para parent_only no subagent
    const events = audit.readAll();
    const denied = events.find(
      (e) => e.tipo === "tool.denied" && e.payload.name === "parent_only",
    );
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("subagent");
  });

  test("(c) subagent pedindo tool fora do teto do parent é negado — escopo nunca maior que o do pai", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-ceil-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Parent tem teto: read_file + write_file
    const parentTools = [readFileTool, writeFileTool];
    const parentAllow = ["read_file", "write_file"];

    const parentExecutor = new ToolExecutor({ approveTool: () => true,
      tools: parentTools,
      allow: parentAllow,
      audit,
    });

    // Subagent tenta ter run_command (que NÃO está no teto do parent)
    // O teto do subagent deve ser o allowlist do parent
    const subExecutor = new ToolExecutor({ approveTool: () => true,
      tools: [...parentTools, runCommandTool],
      allow: ["read_file", "write_file", "run_command"], // teto maior que o do pai
      ceiling: [...parentExecutor.allow], // mas o teto é o do pai
      audit,
    });

    // Subagent tenta run_command → deve ser negado (escopo maior que o do pai)
    const result = await subExecutor.run(
      { cwd, run: "r1", agent: "subagent" },
      call("run_command", { command: "echo hack" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora do teto de escopo");

    // Auditoria
    const events = audit.readAll();
    const denied = events.find(
      (e) => e.tipo === "tool.denied" && e.payload.name === "run_command",
    );
    expect(denied).toBeDefined();
    expect(denied!.agent).toBe("subagent");
  });

  test("(d) tool MCP registrada mid-session sob namespace dinâmico é negada a menos que explicitamente permitida", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-mcp-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));

    // Simula tools MCP descobertas mid-session
    const mcpTool = makeTool("mcp__filesystem__read_file");

    // Executor inicial NÃO tem a tool MCP
    const executor = new ToolExecutor({ approveTool: () => true,
      tools: [readFileTool],
      allow: ["read_file"],
      audit,
    });

    // Tentativa de chamar a tool MCP antes de estar no executor
    const result = await executor.run(
      { cwd, run: "r1", agent: "planner" },
      call("mcp__filesystem__read_file", { path: "test.txt" }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("desconhecida");

    // Auditoria
    const events = audit.readAll();
    const denied = events.find(
      (e) => e.tipo === "tool.denied" && e.payload.name === "mcp__filesystem__read_file",
    );
    expect(denied).toBeDefined();

    // Agora registra a tool MCP explicitamente
    const executorWithMcp = new ToolExecutor({ approveTool: () => true,
      tools: [readFileTool, mcpTool],
      allow: ["read_file", "mcp__filesystem__read_file"],
      audit,
    });

    // Agora deve funcionar
    const result2 = await executorWithMcp.run(
      { cwd, run: "r1", agent: "planner" },
      call("mcp__filesystem__read_file", { path: "test.txt" }),
    );
    expect(result2.isError).toBeFalsy();
  });

  test("(e) entryAgent default name 'planner' pinado contra src/config.ts:82-83 (A13, Q-03)", async () => {
    // Teste de configuração: o entryAgent default deve ser "planner"
    // Este teste valida que a constante não muda silenciosamente
    const { validateConfig } = await import("../src/config");

    const config = validateConfig({
      providers: { a: { kind: "openai-compat", baseUrl: "http://x/v1", credentialRef: "K" } },
      models: [{ provider: "a", id: "m", tags: ["writing-code"], context: 8 }],
      agent: { model: "a/m", maxSteps: 1, tools: [] },
      paths: { ledger: "l", audit: "a" },
    });

    expect(config.agent.entryAgent).toBe("planner");
  });
});