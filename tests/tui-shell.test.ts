import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { createShellRunner } from "../src/tui/shell";
import {
  configureRunCommand,
  isRunCommandSandboxEnabled,
  resolveRunCommandMode,
} from "../src/tools/run-command";
import { installDockerSpawnMock, installNoDockerSpawnMock, type DockerMock } from "./helpers/docker-mock";

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
describe("!cmd always approval reloads the project layer (#599)", () => {
  test("one runner: the second identical command does not prompt", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false, "ask");
    writeFileSync(configPath, JSON.stringify({
      ...JSON.parse(readFileSync(configPath, "utf8")),
      shell: { rules: [{ match: "*", effect: "ask" }] },
    }));
    let prompts = 0;
    const shell = createShellRunner({
      configPath, cwd, env: process.env,
      approveTool: () => { prompts++; return "always"; },
    });
    const first = await shell.run("echo ok");
    expect(first.isError).toBe(false);
    expect(prompts).toBe(1);
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { shell?: { approvals?: unknown } };
    expect(saved.shell?.approvals).toEqual([{ match: "echo *", effect: "allow" }]);
    const second = await shell.run("echo ok");
    expect(second.isError).toBe(false);
    expect(prompts).toBe(1); // the runner sees the saved approval; no second prompt
  });
});

describe("!cmd reload fails closed when the config cannot be re-read (#650)", () => {
  test("a deny written just before a corrupt read still blocks the command", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    const write = (shell: unknown): void => writeFileSync(configPath, JSON.stringify({
      ...JSON.parse(readFileSync(configPath, "utf8")),
      shell,
    }));
    write({ rules: [{ match: "*", effect: "allow" }] });
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    write({ rules: [{ match: "*", effect: "ask" }, { match: "echo *", effect: "deny" }] });
    const narrowed = await shell.run("echo ok");
    expect(narrowed.isError).toBe(true);
    expect(narrowed.output).toContain("shell_rule_denied");
    writeFileSync(configPath, "{ broken");
    const corrupted = await shell.run("echo ok");
    expect(corrupted.isError).toBe(true);
    expect(corrupted.output).toContain("config_unreadable");
    expect(corrupted.output).not.toContain("ran");
  });

  test("a corrupt read never reuses the previous allow", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    writeFileSync(configPath, JSON.stringify({
      ...JSON.parse(readFileSync(configPath, "utf8")),
      shell: { rules: [{ match: "*", effect: "allow" }] },
    }));
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    writeFileSync(configPath, "{ broken");
    const next = await shell.run("echo ok");
    expect(next.isError).toBe(true);
    expect(next.output).toContain("config_unreadable");
    expect(next.output).not.toContain("ran");
    const events = readFileSync(join(cwd, ".astro/audit.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> });
    expect(events).toContainEqual(expect.objectContaining({
      tipo: "host_shell.decision",
      payload: expect.objectContaining({ effect: "deny", origin: "config", reason: expect.stringContaining("config_unreadable") }),
    }));
  });

  test("switching shell.mode to off mid-session refuses the next command", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    const write = (shell: unknown): void => writeFileSync(configPath, JSON.stringify({
      ...JSON.parse(readFileSync(configPath, "utf8")),
      shell,
    }));
    write({ rules: [{ match: "*", effect: "allow" }] });
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    const before = await shell.run("echo ok");
    expect(before.isError).toBe(false);
    write({ mode: "off", rules: [{ match: "*", effect: "allow" }] });
    const after = await shell.run("echo ok");
    expect(after.isError).toBe(true);
    expect(after.output).toContain("sandbox_required_for_shell");
  });
});

describe("!cmd reload covers agent.tools (#650)", () => {
  test("removing run_command from agent.tools mid-session refuses the next command", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    const shell = createShellRunner({ configPath, cwd, env: process.env, approveTool: () => true });
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { agent: { tools: string[] } };
    raw.agent.tools = [];
    writeFileSync(configPath, JSON.stringify(raw));
    const result = await shell.run("echo blocked");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("agent.tools");
    expect(result.output).not.toContain("ran");
    const events = readFileSync(join(cwd, ".astro/audit.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> });
    expect(events).toContainEqual(expect.objectContaining({
      tipo: "host_shell.decision",
      payload: expect.objectContaining({ effect: "deny", origin: "config", reason: "tool_not_allowed" }),
    }));
  });
});

describe("!cmd approval names the prefix always will save (#650)", () => {
  async function promptOnHost(command: string) {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false, "ask");
    let detail: { kind: string; value: string; saves?: string } | undefined;
    const shell = createShellRunner({
      configPath, cwd, env: process.env,
      approveTool: (request) => { detail = request.detail; return false; },
    });
    const result = await shell.run(command);
    return { detail, result };
  }
  test("a single uncovered subcommand shows its saved pattern in the prompt", async () => {
    const { detail, result } = await promptOnHost("git push origin main");
    expect(result.isError).toBe(true);
    expect(detail?.value).toBe("git push origin main");
    expect(detail?.saves).toBe("git push *");
  });

  test("no pattern is named when always cannot save the decision", async () => {
    const { detail } = await promptOnHost("git push origin main && echo ok");
    expect(detail?.saves).toBeUndefined();
  });

  test("a pattern containing a secret is never named", async () => {
    const secret = ["s", "k", "-"].join("") + "live-abcdefghijklmnop";
    const { detail } = await promptOnHost(`${secret} echo ok`);
    expect(detail?.saves).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(secret);
  });

  test("the Docker transport does not name a pattern it cannot persist", async () => {
    const { cwd, configPath } = config(["run_command"], "KEY", true, true, "ask");
    let detail: { kind: string; value: string; saves?: string } | undefined;
    const shell = createShellRunner({
      configPath, cwd, env: process.env,
      approveTool: (request) => { detail = request.detail; return false; },
    });
    const result = await shell.run("git push origin main");
    expect(result.isError).toBe(true);
    expect(detail?.value).toContain("git push origin main");
    expect(detail?.saves).toBeUndefined();
  });
});

describe("!cmd fail-closed reload (#650)", () => {
  test("a project config deleted mid-session denies instead of loading defaults", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    const shell = createShellRunner({
      configPath, cwd, allowMissingConfig: true,
      env: { ...process.env, ASTRO_NO_GLOBAL_CONFIG: "1", OPENAI_API_KEY: "env-key", OPENAI_MODEL: "gpt-5" },
    });
    unlinkSync(configPath);
    const result = await shell.run("echo ok");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("config_unreadable");
    expect(result.output).not.toContain("ran");
  });

  test("a mode change is honored on the next run, not the creation snapshot", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    const writeMode = (mode: string): void => writeFileSync(configPath, JSON.stringify({
      ...JSON.parse(readFileSync(configPath, "utf8")),
      permissions: { mode },
    }));
    writeMode("bypass");
    const shell = createShellRunner({
      configPath, cwd,
      env: { ...process.env, ASTRO_HOST_SHELL_CONFIRM_BYPASS: "1" },
    });
    const first = await shell.run("echo ok");
    expect(first.isError).toBe(false);
    writeMode("ask");
    const second = await shell.run("echo ok");
    expect(second.isError).toBe(true);
  });

  test("a runner disabled at creation still audits the denied attempt", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config([], "KEY", false, false);
    const shell = createShellRunner({ configPath, cwd, env: process.env });
    expect(shell.enabled).toBe(false);
    const result = await shell.run("echo ok");
    expect(result.isError).toBe(true);
    const events = readFileSync(join(cwd, ".astro/audit.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> });
    expect(events).toContainEqual(expect.objectContaining({
      tipo: "host_shell.decision",
      payload: expect.objectContaining({ effect: "deny", origin: "config", reason: "tool_not_allowed" }),
    }));
  });

  test("a config created and observed mid-session denies after deletion", async () => {
    mock.restore();
    mock = installNoDockerSpawnMock({ stdout: "ran\n" });
    const { cwd, configPath } = config(["run_command"], "KEY", false, false);
    const raw = readFileSync(configPath, "utf8");
    unlinkSync(configPath);
    const home = mkdtempSync(join(tmpdir(), "astro-shell-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: { g: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
      models: [{ provider: "g", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "g/m1", tools: ["run_command"] },
    }));
    const shell = createShellRunner({
      configPath, cwd, allowMissingConfig: true, env: { ...process.env, ASTRO_HOME: home },
      approveTool: () => true,
    });
    expect((await shell.run("echo ok")).isError).toBe(false);
    writeFileSync(configPath, raw);
    expect((await shell.run("echo ok")).isError).toBe(false);
    unlinkSync(configPath);
    const third = await shell.run("echo ok");
    expect(third.isError).toBe(true);
    expect(third.output).toContain("config_unreadable");
  });
});
