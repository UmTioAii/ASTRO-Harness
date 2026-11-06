import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { resolveWithin } from "../src/tools/paths";
import { readFileTool } from "../src/tools/read-file";
import { runCommandTool, configureRunCommand } from "../src/tools/run-command";
import type { Tool, ToolResult } from "../src/tools/types";
import { writeFileTool } from "../src/tools/write-file";

const dir = () => mkdtempSync(join(tmpdir(), "astro-tools-"));
const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "default" });
const tools = [readFileTool, writeFileTool, runCommandTool];
const mkExec = (cwd: string) =>
  new ToolExecutor({ approveTool: () => true, tools, allow: tools.map((t) => t.manifest.name), audit: new Auditor(join(cwd, ".astro", "audit.jsonl")) });

// --- Sandbox com Docker mockado (ADR-0027 slice 4) ---
// A query string quebra o cache ESM: cada chamada devolve uma instância ISOLADA
// de run-command (sandboxEnabled/dockerProbe privativos), então o mock de
// Bun.spawn não contamina o módulo compartilhado usado por app/TUI/outros testes.
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
// recusa no host com sandbox_required_for_shell e não faz spawn. Os testes que
// exercitam execução usam instância isolada do módulo com Docker mockado (ver
// freshRunCommand/installDockerMock abaixo).
beforeEach(() => configureRunCommand({ sandbox: false }));

test("caminho fora do cwd é recusado; dentro é aceito", () => {
  const cwd = dir();
  expect(resolveWithin(cwd, "ok.txt")).toBe(join(cwd, "ok.txt"));
  expect(() => resolveWithin(cwd, "../escape.txt")).toThrow(/fora/);
  expect(() => resolveWithin(cwd, resolve(cwd, "..", "outside.txt"))).toThrow(/fora/);
});

test("write+read roundtrip no cwd", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  const w = await ex.run(ctx(cwd), { id: "1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "olá" }) });
  expect(w.isError).toBeFalsy();
  const r = await ex.run(ctx(cwd), { id: "2", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) });
  expect(r.output).toBe("linhas 1-1 de 1\nolá");
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("olá");
});

test("tool desconhecida, args ilegíveis e fora do allow → erro, não crash", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  expect((await ex.run(ctx(cwd), { id: "1", name: "ghost", arguments: "{}" })).isError).toBe(true);
  expect((await ex.run(ctx(cwd), { id: "2", name: "read_file", arguments: "{quebrado" })).isError).toBe(true);
  const denied = new ToolExecutor({ approveTool: () => true, tools: [readFileTool], allow: [], audit: new Auditor(join(cwd, ".astro", "audit2.jsonl")) });
  expect((await denied.run(ctx(cwd), { id: "3", name: "read_file", arguments: '{"path":"a.txt"}' })).isError).toBe(true);
});

test("timeout devolve erro", async () => {
  const cwd = dir();
  const slow: Tool = {
    manifest: { name: "slow", description: "x", parameters: {}, risk: "low", permission: "read", timeoutMs: 30, retryable: false, idempotent: true, sideEffects: "none", class: "read_common" },
    execute: () => new Promise<ToolResult>(() => {}),
  };
  const ex = new ToolExecutor({ approveTool: () => true, tools: [slow], allow: ["slow"], audit: new Auditor(join(cwd, ".astro", "audit.jsonl")) });
  const r = await ex.run(ctx(cwd), { id: "1", name: "slow", arguments: "{}" });
  expect(r.isError).toBe(true);
  expect(r.output.toLowerCase()).toContain("timeout");
});

test("run_command captura a saída do sandbox (Docker mockado; nada roda no host)", async () => {
  const rc = await freshRunCommand("tools-capture");
  rc.configureRunCommand({ sandbox: true });
  const mock = installDockerMock(() => ({ stdout: "1.4.2\n", code: 0 }));
  try {
    const cwd = dir();
    const ex = new ToolExecutor({
      approveTool: () => true,
      tools: [rc.runCommandTool],
      allow: ["run_command"],
      audit: new Auditor(join(cwd, ".astro", "audit.jsonl")),
    });
    const r = await ex.run(ctx(cwd), { id: "1", name: "run_command", arguments: JSON.stringify({ command: "bun --version" }) });
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("1.4.2");
    // slice 4: o comando nunca vai para o host — só o CLI do docker é spawnado
    const runCalls = mock.calls.filter((c) => c.cmd[0] === "docker" && c.cmd[1] === "run");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.cmd.at(-1)).toBe("bun --version");
    expect(mock.calls.every((c) => c.cmd[0] === "docker")).toBe(true);
  } finally {
    mock.restore();
  }
});

// Segredo sintético construído em runtime (gate G6: sem literal de segredo no diff).
const RUN_SECRET = ["s", "k", "-"].join("") + "slice3a-run-synthetic-9f8e7d6c5b";

test("run_command redige stdout do sandbox antes de truncar (ADR-0027, I-03)", async () => {
  const rc = await freshRunCommand("tools-redact");
  rc.configureRunCommand({ sandbox: true });
  // Saída pronta "do container" com segredo + payload > 10k: o mock não executa nada.
  const canned = `token=${RUN_SECRET}\n${"y".repeat(20_000)}\n${RUN_SECRET}\n`;
  const mock = installDockerMock(() => ({ stdout: canned, code: 0 }));
  try {
    const cwd = dir();
    const r = await rc.runCommandTool.execute({ command: "bun p.js" }, ctx(cwd));
    expect(r.isError).toBeFalsy();
    // O segredo cru não pode aparecer em lugar nenhum da saída truncada…
    expect(r.output).not.toContain(RUN_SECRET);
    // …e o que cabe nos primeiros 10k chars sai mascarado, não verbatim.
    expect(r.output).toContain("[REDACTED]");
    expect(r.output.length).toBeLessThanOrEqual(10_000);
  } finally {
    mock.restore();
  }
});

test("emite tool.call e tool.result na auditoria", async () => {
  const cwd = dir();
  const ex = mkExec(cwd);
  await ex.run(ctx(cwd), { id: "1", name: "write_file", arguments: JSON.stringify({ path: "b.txt", content: "x" }) });
  const lines = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.tipo)).toEqual(["tool.call", "permission.decision", "tool.result"]);
});
