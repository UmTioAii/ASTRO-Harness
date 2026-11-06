import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ProviderError } from "../src/provider/types";
import { runTask } from "../src/app";
import { editTool } from "../src/tools/edit";
import { readFileTool } from "../src/tools/read-file";
import { configureRunCommand } from "../src/tools/run-command";
import { writeFileTool } from "../src/tools/write-file";
import type { ToolContext } from "../src/tools/types";

// ADR-0027 slice 4: no módulo compartilhado fica sandbox:false — run_command
// recusa no host (sandbox_required_for_shell). Os testes de env abaixo usam
// instância isolada do módulo com Docker mockado (ver freshRunCommand abaixo).
beforeEach(() => configureRunCommand({ sandbox: false }));

const dir = () => mkdtempSync(join(tmpdir(), "astro-sec-"));

const ctx = (cwd: string, extra?: Partial<ToolContext>): ToolContext => ({
  cwd,
  run: "sec-f00",
  agent: "tester",
  ...(extra ?? {}),
});

/** Prova se a plataforma suporta link de diretório (junction no Windows). */
function supportsDirectoryLink(): boolean {
  const root = dir();
  const target = dir();
  try {
    symlinkSync(target, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

const hasDirLink = supportsDirectoryLink();

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

describe("segurança F-00", () => {
  test("run_command não expõe variáveis de segredo do ambiente de lançamento ao processo spawnado (sandbox, I-03)", async () => {
    const rc = await freshRunCommand("f00-env");
    rc.configureRunCommand({ sandbox: true });
    const prevSecret = process.env.ASTRO_SEC_SECRET;
    const prevSafe = process.env.ASTRO_SEC_SAFE;
    process.env.ASTRO_SEC_SECRET = "sec1";
    process.env.ASTRO_SEC_SAFE = "safe1";
    const mock = installDockerMock(() => ({ stdout: "ok\n", code: 0 }));
    try {
      const cwd = dir();
      const result = await rc.runCommandTool.execute({ command: "bun print-env.js" }, ctx(cwd));
      expect(result.isError).toBeFalsy();
      const runCall = mock.calls.find((c) => c.cmd[0] === "docker" && c.cmd[1] === "run");
      expect(runCall).toBeDefined();
      // slice 4: o shell roda em container e o processo spawnado (docker CLI) recebe
      // só env mínimo — nem segredo nem variável "safe" do host entra (I-03)
      const env = (runCall!.opts as { env?: Record<string, string> }).env ?? {};
      expect(env.ASTRO_SEC_SECRET).toBeUndefined();
      expect(env.ASTRO_SEC_SAFE).toBeUndefined();
      expect(env.PATH).toBeDefined(); // PATH sobrevive para o docker CLI
      // nada de segredo no argv (nem no comando, nem em --env)
      expect(runCall!.cmd.join("\n")).not.toContain("sec1");
      expect(runCall!.cmd.join("\n")).not.toContain("ASTRO_SEC_SECRET");
      // e a saída devolvida ao modelo não vaza o valor (I-03)
      expect(result.output).not.toContain("sec1");
    } finally {
      mock.restore();
      if (prevSecret === undefined) delete process.env.ASTRO_SEC_SECRET;
      else process.env.ASTRO_SEC_SECRET = prevSecret;
      if (prevSafe === undefined) delete process.env.ASTRO_SEC_SAFE;
      else process.env.ASTRO_SEC_SAFE = prevSafe;
    }
  });

  test("run_command não entrega credentialRef declarado em secretEnvNames ao processo spawnado (sandbox, I-03)", async () => {
    const rc = await freshRunCommand("f00-cred");
    rc.configureRunCommand({ sandbox: true });
    const prev = process.env.ASTRO_SEC_CRED;
    // "CRED" não casa com o padrão de nome; só a lista exata (secretEnvNames) o marca
    process.env.ASTRO_SEC_CRED = "cred1";
    const mock = installDockerMock(() => ({ stdout: "ok\n", code: 0 }));
    try {
      const cwd = dir();
      const result = await rc.runCommandTool.execute(
        { command: "bun print-cred.js" },
        ctx(cwd, { secretEnvNames: ["ASTRO_SEC_CRED"] }),
      );
      expect(result.isError).toBeFalsy();
      const runCall = mock.calls.find((c) => c.cmd[0] === "docker" && c.cmd[1] === "run");
      expect(runCall).toBeDefined();
      const env = (runCall!.opts as { env?: Record<string, string> }).env ?? {};
      expect(env.ASTRO_SEC_CRED).toBeUndefined();
      expect(runCall!.cmd.join("\n")).not.toContain("cred1");
      expect(runCall!.cmd.join("\n")).not.toContain("ASTRO_SEC_CRED");
      expect(result.output).not.toContain("cred1");
    } finally {
      mock.restore();
      if (prev === undefined) delete process.env.ASTRO_SEC_CRED;
      else process.env.ASTRO_SEC_CRED = prev;
    }
  });

  test("read_file não escapa do cwd por symlink/junction de diretório", async () => {
    if (!hasDirLink) return; // plataforma sem suporte: sem assertions, sem .skip
    const cwd = dir();
    const outside = dir();
    writeFileSync(join(outside, "secreto.txt"), "conteudo-externo");
    symlinkSync(outside, join(cwd, "atalho"), process.platform === "win32" ? "junction" : "dir");
    const result = await readFileTool.execute({ path: "atalho/secreto.txt" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora");
  });

  test("write_file recusa o estado do harness (.astro/)", async () => {
    const cwd = dir();
    const result = await writeFileTool.execute(
      { path: ".astro/ledger.jsonl", content: "tampado" },
      ctx(cwd),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("reservado");
  });

  test("write_file recusa caminho protegido declarado e não sobrescreve", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "protegido.txt"), "original");
    const result = await writeFileTool.execute(
      { path: "protegido.txt", content: "tampado" },
      ctx(cwd, { protectedPaths: [join(cwd, "protegido.txt")] }),
    );
    expect(result.isError).toBe(true);
    expect(readFileSync(join(cwd, "protegido.txt"), "utf8")).toBe("original");
  });

  test("edit recusa o estado do harness (.astro/) antes de backup e escrita", async () => {
    const cwd = dir();
    const ledger = join(cwd, ".astro", "ledger.jsonl");
    mkdirSync(join(cwd, ".astro"), { recursive: true });
    writeFileSync(ledger, "original\n");
    const diff = `--- a/.astro/ledger.jsonl
+++ b/.astro/ledger.jsonl
@@ -1,1 +1,1 @@
-original
+tampado
`;
    const result = await editTool.execute({ path: ".astro/ledger.jsonl", diff }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("reservado");
    expect(readFileSync(ledger, "utf8")).toBe("original\n");
    expect(readdirSync(join(cwd, ".astro")).filter((f) => f.endsWith(".bak"))).toHaveLength(0);
  });

  test("edit recusa caminho protegido declarado e não sobrescreve", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "protegido.txt"), "original\n");
    const diff = `--- a/protegido.txt
+++ b/protegido.txt
@@ -1,1 +1,1 @@
-original
+tampado
`;
    const result = await editTool.execute(
      { path: "protegido.txt", diff },
      ctx(cwd, { protectedPaths: [join(cwd, "protegido.txt")] }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("reservado");
    expect(readFileSync(join(cwd, "protegido.txt"), "utf8")).toBe("original\n");
  });

  test("run que falha no provider registra run.stopped com reason e errorClass", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(): Promise<Response> {
        return new Response("unauthorized", { status: 401 });
      },
    });
    const cwd = dir();
    try {
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          providers: {
            mock: {
              kind: "openai-compat",
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              credentialRef: "ASTRO_SEC_KEY",
            },
          },
          models: [{ provider: "mock", id: "m1", tags: ["fast"], context: 4096 }],
          agent: { model: "mock/m1", maxSteps: 3, tools: [] },
          paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
        }),
      );
      const err = await runTask({
        configPath,
        task: "x",
        cwd,
        env: { ASTRO_SEC_KEY: "key-tst" },
      }).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ProviderError);
      const auditText = readFileSync(join(cwd, ".astro", "audit.jsonl"), "utf8");
      expect(auditText).toContain("run.stopped");
      expect(auditText).toContain('"reason":"error"');
      expect(auditText).toContain('"errorClass":"auth"');
      expect(auditText).not.toContain("key-tst");
    } finally {
      server.stop(true);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
