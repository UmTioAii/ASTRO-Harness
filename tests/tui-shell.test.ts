import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellRunner } from "../src/tui/shell";
import {
  configureRunCommand,
  detectDockerAvailable,
  isRunCommandSandboxEnabled,
} from "../src/tools/run-command";

function config(tools: string[], credentialRef = "KEY", sandbox = false, withTools = true) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-shell-"));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "p/m1", maxSteps: 2, tools },
    ...(withTools ? { tools: { run_command: { sandbox } } } : {}),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath };
}

const slowCommand = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 5";

// --- Sandbox com Docker mockado (ADR-0027 slice 4) ---
// Query string quebra o cache ESM: instância ISOLADA de run-command por teste,
// com sandbox ligado e Bun.spawn/Bun.spawnSync mockados (probe = engine Linux,
// `docker run` chama onRun, podendo "hang"). Nada executa de verdade e o módulo
// compartilhado (usado pelo createShellRunner) não é contaminado.
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

describe("!cmd da TUI (T2, #63)", () => {
  afterEach(() => {
    configureRunCommand({ sandbox: false });
  });

  test("sem seção tools na config: sandbox ligado por padrão (fail-closed, I-11)", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    // approveTool permite atravessar o gate fail-closed (#259) e exercitar o sandbox
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(true);
    expect(isRunCommandSandboxEnabled()).toBe(true);
    const docker = await detectDockerAvailable();
    const result = await shell.run("echo astro-shell-default");
    if (!docker) {
      expect(result.isError).toBe(true);
      expect(result.output).toContain("sandbox");
    } else {
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("astro-shell-default");
    }
  });

  test("na allowlist o shell chama run_command e audita; com sandbox:false a tool recusa (sandbox_required_for_shell)", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(true);
    const result = await shell.run("echo astro-shell");
    // slice 4 (ADR-0027): a allowlist deixou passar (não é erro de allowlist), mas
    // o shell não roda no host — run_command recusa fail-closed
    expect(result.isError).toBe(true);
    expect(result.output).toContain("sandbox_required_for_shell");
    expect(result.output).not.toContain("allowlist");
    expect(result.output).not.toContain("astro-shell"); // o comando não ecoa na recusa (I-03)
    expect(existsSync(join(cwd, ".astro", "audit.jsonl"))).toBe(true);
  });

  test("sem allowlist fica desabilitado e não executa nada", async () => {
    const { cwd, configPath } = config(["read_file"]);
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(false);
    const result = await shell.run("echo x > denied.txt");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("allowlist");
    expect(existsSync(join(cwd, "denied.txt"))).toBe(false);
  });

  test("comando vazio e falha do shell viram erro sem quebrar", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    expect(await shell.run("   ")).toMatchObject({ isError: true });
    const failed = await shell.run("comando-que-nao-existe-astro");
    expect(failed.isError).toBe(true);
    expect(failed.output.length).toBeGreaterThan(0);
  });

  test("não expõe credentialRef que não casa com SECRET_ENV", async () => {
    const { cwd, configPath } = config(["run_command"], "MY_API");
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: { ...process.env, MY_API: "hunter2-abc" } });
    const command = process.platform === "win32" ? "echo %MY_API%" : "printenv MY_API";
    const result = await shell.run(command);
    expect(result.output).not.toContain("hunter2-abc");
  });

  test("abortar o sinal encerra o comando no sandbox em vez de esperar o timeout (docker run mockado em hang)", async () => {
    const rc = await freshRunCommand("tui-abort");
    rc.configureRunCommand({ sandbox: true });
    const mock = installDockerMock(() => "hang"); // docker run "não retorna"
    try {
      const cwd = mkdtempSync(join(tmpdir(), "astro-shell-abort-"));
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 50);
      // mesma tool que o shell da TUI usa (src/tui/shell.ts chama runCommandTool)
      const result = await rc.runCommandTool.execute(
        { command: slowCommand },
        { cwd, run: "r1", agent: "default", signal: controller.signal },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cancelado");
      expect(Date.now() - started).toBeLessThan(4000);
      // no abort o container é removido (docker rm -f <nome>)
      expect(mock.syncCalls.some((c) => c.cmd[0] === "docker" && c.cmd[1] === "rm" && c.cmd[2] === "-f")).toBe(true);
    } finally {
      mock.restore();
    }
  });
});

test("abortar mata a árvore do processo (taskkill /T no Windows, grupo no POSIX), não só o shell", async () => {
  const rc = await freshRunCommand("tui-abort-tree");
  rc.configureRunCommand({ sandbox: true });
  const mock = installDockerMock(() => "hang");
  try {
    const cwd = mkdtempSync(join(tmpdir(), "astro-shell-tree-"));
    const controller = new AbortController();
    const pending = rc.runCommandTool.execute(
      { command: "bun slow.js" },
      { cwd, run: "r1", agent: "default", signal: controller.signal },
    );
    // espera o docker run ter sido spawnado
    for (let i = 0; i < 60 && !mock.calls.some((c) => c.cmd[0] === "docker" && c.cmd[1] === "run"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(mock.calls.some((c) => c.cmd[0] === "docker" && c.cmd[1] === "run")).toBe(true);
    const runProc = mock.procs.at(-1)!;
    controller.abort();
    const result = await pending;
    expect(result.output).toContain("cancelado");
    // kill da ÁRVORE: taskkill /T /F com o pid do processo (Windows) ou kill do proc (fallback POSIX)
    const treeKill =
      mock.syncCalls.some(
        (c) => c.cmd[0] === "taskkill" && c.cmd.includes(String(runProc.pid)) && c.cmd.includes("/T"),
      ) || runProc.killed;
    expect(treeKill).toBe(true);
  } finally {
    mock.restore();
  }
});