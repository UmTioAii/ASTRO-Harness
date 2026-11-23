import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { createShellRunner } from "../src/tui/shell";
import {
  configureRunCommand,
  isRunCommandSandboxEnabled,
  resolveRunCommandMode,
} from "../src/tools/run-command";
import { installDockerSpawnMock, type DockerMock } from "./helpers/docker-mock";

// Slice 4b: os testes rodam só via docker (mock) — o host nunca executa o comando.
let mock: DockerMock;
beforeEach(() => {
  mock = installDockerSpawnMock();
});
afterEach(() => mock.restore());

function config(tools: string[], credentialRef = "KEY", sandbox = true, withTools = true, mode?: "bypass" | "allow-edits" | "ask") {
  const cwd = mkdtempSync(join(tmpdir(), "astro-shell-"));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "p/m1", maxSteps: 2, tools },
    ...(withTools ? { tools: { run_command: { sandbox } } } : {}),
    ...(mode === undefined ? {} : { permissions: { mode } }),
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath };
}

const slowCommand = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 5";

describe("!cmd da TUI (T2, #63)", () => {
  afterEach(() => {
    configureRunCommand({ sandbox: false });
  });

  test("sem seção tools: host por padrão, sem probe de Docker (#474, #599)", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    // approveTool permite atravessar o gate fail-closed (#259)
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(true);
    expect(isRunCommandSandboxEnabled()).toBe(false); // host não é "Docker-only"
    expect(resolveRunCommandMode(undefined)).toBe("host");
    // Docker do mock está disponível, mas o host não o usa.
    mock.restore();
    mock = installDockerSpawnMock(() => "docker-should-not-run");
    const result = await shell.run("echo astro-shell-default");
    expect(mock.runCalls).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("astro-shell-default");
  });

  test("executa via run_command quando está na allowlist e audita", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(true);
    const result = await shell.run("echo astro-shell");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("astro-shell");
    expect(existsSync(join(cwd, ".astro", "audit.jsonl"))).toBe(true);
  });

  test("!cmd emite security.allowlist_applied no load (allow-sensitive)", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({
      approveTool: () => true, configPath, cwd, env: process.env, allowSensitive: ["*.md"],
    });
    const first = await shell.run("echo astro-allow");
    const second = await shell.run("echo astro-allow-2");
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    const events = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
    expect(events.filter((event) => event.tipo === "security.allowlist_applied"
      && (event.payload as { rule?: string }).rule === "allow-sensitive")).toHaveLength(1);
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

  test("abortar o sinal encerra o comando em vez de esperar o timeout", async () => {
    const { cwd, configPath } = config(["run_command"]);
    const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const result = await shell.run(slowCommand, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cancelado");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("!cmd segue o modo de permissão resolvido, por comando (#557)", () => {
  afterEach(() => {
    configureRunCommand({ sandbox: false });
    delete process.env.ASTRO_PERMISSION_MODE;
  });

  test("modo bypass da config: executa sem aprovador e sem perguntar", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", true, true, "bypass");
    // Sem approveTool algum: em bypass o gate não pode cair no fail-closed de ask.
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    const result = await shell.run("echo astro-bypass-557");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("astro-bypass-557");
    expect(result.output).not.toContain("permissão negada");
  });

  test("ASTRO_PERMISSION_MODE=bypass no env vence a config ask (D-24)", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", true, true, "ask");
    const shell = createShellRunner({
      configPath, cwd, env: { ...process.env, ASTRO_PERMISSION_MODE: "bypass" },
    });
    const result = await shell.run("echo astro-env-bypass-557");
    expect(result.isError).toBe(false);
    expect(result.output).toContain("astro-env-bypass-557");
  });

  test("modo ask da config: pergunta por comando (ação shell) e negar bloqueia", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", true, true, "ask");
    const seen: string[] = [];
    const shell = createShellRunner({
      configPath, cwd, env: process.env,
      approveTool: (request) => {
        seen.push(`${request.name}:${request.action}:${request.mode}`);
        return false;
      },
    });
    const denied = await shell.run("echo astro-deny-557");
    expect(seen).toEqual(["run_command:shell:ask"]);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("permissão negada");
    // Aprovando, o mesmo comando executa:
    const shellOk = createShellRunner({ configPath, cwd, env: process.env, approveTool: () => true });
    const ok = await shellOk.run("echo astro-ask-557");
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain("astro-ask-557");
  });

  test("modo allow-edits da config: shell continua pedindo aprovação (MATRIX)", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", true, true, "allow-edits");
    let asked = 0;
    const shell = createShellRunner({
      configPath, cwd, env: process.env,
      approveTool: () => { asked += 1; return true; },
    });
    const result = await shell.run("echo astro-edits-557");
    expect(asked).toBe(1); // allow-edits não cobre a ação shell
    expect(result.isError).toBe(false);
    expect(result.output).toContain("astro-edits-557");
  });

  test("permissionMode explícito (runtime /mode) vence a config e é reavaliado por run", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", true, true, "ask");
    let asked = 0;
    let mode: "ask" | "bypass" = "ask";
    const shell = createShellRunner({
      configPath, cwd, env: process.env,
      approveTool: () => { asked += 1; return true; },
      permissionMode: () => mode,
    });
    const denied = await shell.run("echo astro-mode-ask-557");
    expect(asked).toBe(1); // ask perguntou
    expect(denied.isError).toBe(false);
    mode = "bypass"; // /mode bypass em runtime
    const bypassed = await shell.run("echo astro-mode-bypass-557");
    expect(asked).toBe(1); // bypass não perguntou de novo
    expect(bypassed.isError).toBe(false);
    expect(bypassed.output).toContain("astro-mode-bypass-557");
  });
});

test("abortar mata o processo filho, não só o shell", async () => {
  const { cwd, configPath } = config(["run_command"]);
  const shell = createShellRunner({ approveTool: () => true, configPath, cwd, env: process.env });
  writeFileSync(join(cwd, "slow.js"), 'require("fs").writeFileSync("child.pid", String(process.pid)); setTimeout(() => {}, 30000);', "utf8");
  const controller = new AbortController();
  const pending = shell.run("bun slow.js", controller.signal);
  let childPid: number | undefined;
  for (let i = 0; i < 60 && childPid === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      childPid = Number(readFileSync(join(cwd, "child.pid"), "utf8"));
    } catch {
      // ainda não escreveu
    }
  }
  expect(childPid).toBeDefined();
  controller.abort();
  const result = await pending;
  expect(result.output).toContain("cancelado");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(() => process.kill(childPid!, 0)).toThrow();
});