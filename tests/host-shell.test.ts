import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { hostShellNotice } from "../src/core/app";
import { validateConfig, ConfigError } from "../src/core/config";
import { parseConfigEditValue } from "../src/core/config-edit";
import { ToolExecutor } from "../src/tools/executor";
import { HOST_SHELLS, detectHostShells, hostShellArgv, selectHostShell } from "../src/tools/host-shell";
import type { ToolContext, ToolResult } from "../src/tools/types";
import {
  HOST_SHELL_BYPASS_CONFIRMATION_ENV,
  MAX_OUTPUT,
  configureRunCommand,
  resolveRunCommandMode,
  runCommandTool,
} from "../src/tools/run-command";
import { installDockerSpawnMock, installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";

let mock: DockerMock | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
});

const baseConfig = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

const cwd = (): string => mkdtempSync(join(tmpdir(), "astro-host-"));

function auditEvents(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function hostExecutor(
  mod: Awaited<ReturnType<typeof isolatedRunCommand>>,
  opts: { cwd: string; mode?: "ask" | "allow-edits" | "bypass"; approve?: (request: unknown) => unknown; env?: NodeJS.ProcessEnv },
): Promise<{ executor: ToolExecutor; auditPath: string; requests: unknown[] }> {
  const auditPath = join(opts.cwd, ".astro", "audit.jsonl");
  const requests: unknown[] = [];
  const executor = new ToolExecutor({
    tools: [mod.runCommandTool],
    allow: ["run_command"],
    audit: new Auditor(auditPath),
    permissionMode: opts.mode ?? "ask",
    approveTool: (request) => {
      requests.push(request);
      const answer = opts.approve?.(request);
      return answer === undefined ? true : (answer as boolean);
    },
  });
  return { executor, auditPath, requests };
}

const ctxOf = (dir: string, extra: Partial<ToolContext> = {}): ToolContext => ({
  cwd: dir, run: "r1", agent: "coder", env: { ...process.env }, secretEnvNames: ["OPENAI_API_KEY"], ...extra,
});

describe("config do shell: host é o default; o alias legado seleciona Docker (#474, #599)", () => {
  test("ausente e 'auto' = host; true e 'docker' = Docker; false desliga", () => {
    const cfg = validateConfig(structuredClone(baseConfig));
    expect(cfg.tools?.run_command?.sandbox).toBeUndefined();
    expect(resolveRunCommandMode(cfg.tools?.run_command?.sandbox)).toBe("host");
    expect(resolveRunCommandMode(undefined)).toBe("host");
    expect(resolveRunCommandMode("auto")).toBe("host");
    expect(resolveRunCommandMode(true)).toBe("docker");
    expect(resolveRunCommandMode("docker")).toBe("docker");
    expect(resolveRunCommandMode(false)).toBe("disabled");
  });

  test("'auto' e 'docker' aceitos; valor fora do vocabulário é ConfigError", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: "auto" } };
    expect(validateConfig(raw).tools?.run_command?.sandbox).toBe("auto");
    const docker = structuredClone(baseConfig) as Record<string, unknown>;
    docker.tools = { run_command: { sandbox: "docker" } };
    expect(validateConfig(docker).tools?.run_command?.sandbox).toBe("docker");
    const bad = structuredClone(baseConfig) as Record<string, unknown>;
    bad.tools = { run_command: { sandbox: "host" } };
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("shell.default só aceita shell do vocabulário", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.shell = { default: "pwsh" };
    expect(validateConfig(raw).shell?.default).toBe("pwsh");
    const bad = structuredClone(baseConfig) as Record<string, unknown>;
    bad.shell = { default: "fish" };
    expect(() => validateConfig(bad)).toThrow(ConfigError);
  });

  test("/shell grava shell.default pelo /config com validação do vocabulário", () => {
    expect(parseConfigEditValue("shell.default", "cmd")).toBe("cmd");
    expect(() => parseConfigEditValue("shell.default", "fish")).toThrow(ConfigError);
  });

  test("hostShellNotice only fires for a host-mode agent that has run_command", () => {
    expect(hostShellNotice(["run_command"], "host")).toContain("per-command approval");
    expect(hostShellNotice(["run_command"], "host", true)).toBeUndefined();
    expect(hostShellNotice([], "host")).toBeUndefined();
    expect(hostShellNotice(["run_command"], "docker")).toBeUndefined();
    expect(hostShellNotice(["run_command"], "disabled")).toBeUndefined();
  });

  test("the example config documents the host default through shell.mode", () => {
    const example = JSON.parse(readFileSync("astro.config.example.json", "utf8")) as Record<string, unknown>;
    expect(example.version).toBe("2.0.0");
    expect(example.shell).toEqual({ mode: "host" });
    expect(JSON.stringify(example)).not.toContain('"sandbox"');
    expect(() => validateConfig(structuredClone(example))).not.toThrow();
  });
});

describe("detecção e argv de shell do host (#474)", () => {
  test("lista só os shells presentes, na ordem canônica", () => {
    const present = new Set(["cmd", "bash"]);
    const which = (name: string): string | null => (present.has(name) ? `C:/bin/${name}` : null);
    expect(detectHostShells(which)).toEqual(["cmd", "bash"]);
    expect(HOST_SHELLS).toContain("pwsh");
  });

  test("selectHostShell respeita o default configurado e falha fechado quando ausente", () => {
    expect(selectHostShell(["powershell", "cmd"], "cmd")).toEqual({ kind: "shell", shell: "cmd" });
    expect(selectHostShell(["cmd"], "bash")).toMatchObject({ kind: "error", code: "shell_not_available" });
    expect(selectHostShell([], undefined)).toMatchObject({ kind: "error", code: "shell_none_available" });
    // default por plataforma: Windows prefere pwsh, POSIX prefere sh via bash/zsh/sh
    expect(selectHostShell(["cmd", "powershell"], undefined, "win32")).toEqual({ kind: "shell", shell: "powershell" });
    expect(selectHostShell(["sh", "bash"], undefined, "linux")).toEqual({ kind: "shell", shell: "bash" });
  });

  test("argv do host passa o comando como argumento único do shell", () => {
    expect(hostShellArgv("cmd", "echo a && echo b")).toEqual(["cmd.exe", "/d", "/s", "/c", "echo a && echo b"]);
    expect(hostShellArgv("powershell", "Get-ChildItem")).toEqual([
      "powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem",
    ]);
    expect(hostShellArgv("sh", "echo oi")).toEqual(["sh", "-c", "echo oi"]);
  });
});

describe("run_command on the host by default, approved per command (#474, #599)", () => {
  test("the default mode runs on the host without probing Docker, with the command in the prompt", async () => {
    mock = installNoDockerSpawnMock({ stdout: "astro-host-default\n" });
    const mod = await isolatedRunCommand("host-default-approve");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor, requests, auditPath } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo astro-host-default" }),
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("astro-host-default");
    expect(requests).toHaveLength(1);
    expect((requests[0] as { detail?: { kind: string; value: string } }).detail).toEqual({
      kind: "command", value: "echo astro-host-default",
    });
    // The host path never probes or calls Docker.
    expect(mock.calls.some((cmd) => cmd[0] === "docker")).toBe(false);
    expect(mock.runCalls).toHaveLength(0);
    const hostEvent = auditEvents(auditPath).find((event) => event.tipo === "host_shell.decision");
    expect(hostEvent?.payload).toMatchObject({ decision: "allow", permissionMode: "ask" });
    expect(JSON.stringify(hostEvent)).not.toContain("astro-host-default");
  });

  test("the default host ignores an available Docker daemon", async () => {
    mock = installDockerSpawnMock(() => "docker-ok");
    const mod = await isolatedRunCommand("host-default-ignores-docker");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor, requests } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo host-ok" }),
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("host-ok");
    expect(requests).toHaveLength(1); // o gate continua perguntando por comando
    expect(mock.runCalls).toHaveLength(0);
    expect(mock.calls.some((cmd) => cmd[0] === "docker")).toBe(false);
  });

  test("sandbox:true segue no Docker e só spawna docker", async () => {
    mock = installDockerSpawnMock(() => "docker-ok");
    const mod = await isolatedRunCommand("host-regress-docker");
    mod.configureRunCommand({ sandbox: true });
    const result = await mod.runCommandTool.execute({ command: "echo oi" }, ctxOf(cwd()));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("docker-ok");
    expect(mock.runCalls.length).toBeGreaterThan(0);
    expect(mock.calls.every((cmd) => cmd[0] === "docker")).toBe(true);
  });

  test("sandbox:'docker' também usa só o Docker", async () => {
    mock = installDockerSpawnMock(() => "docker-ok");
    const mod = await isolatedRunCommand("host-docker-string");
    mod.configureRunCommand({ mode: "docker" });
    const result = await mod.runCommandTool.execute({ command: "echo oi" }, ctxOf(cwd()));
    expect(result.output).toContain("docker-ok");
    expect(mock.calls.every((cmd) => cmd[0] === "docker")).toBe(true);
  });

  test("sandbox:true sem Docker recusa e não cai no host", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-docker-refuse");
    mod.configureRunCommand({ sandbox: true });
    const result = await mod.runCommandTool.execute({ command: "echo oi" }, ctxOf(cwd()));
    expect(result.isError).toBe(true);
    expect(result.code).toBe("sandbox_required_for_shell");
    expect(result.output).toContain("Docker");
    expect(mock.calls.filter((cmd) => cmd[0] !== "docker")).toHaveLength(0);
  });

  test("sandbox:'docker' sem Docker também recusa, sem fallback para o host", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-docker-string-refuse");
    mod.configureRunCommand({ mode: "docker" });
    const result = await mod.runCommandTool.execute({ command: "echo oi" }, ctxOf(cwd()));
    expect(result.isError).toBe(true);
    expect(result.code).toBe("sandbox_required_for_shell");
    expect(result.output).toContain("Docker");
    expect(mock.calls.filter((cmd) => cmd[0] !== "docker")).toHaveLength(0);
  });

  test("negar a aprovação não executa nada e o audit registra a decisão sem o comando", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-deny");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor, auditPath } = await hostExecutor(mod, { cwd: dir, approve: () => false });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo TOPSECRET-abc123" }),
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("permissão negada");
    expect(mock.calls).toHaveLength(0);
    const events = auditEvents(auditPath);
    const decision = events.find((event) => event.tipo === "permission.decision");
    expect(decision?.payload).toMatchObject({ name: "run_command", decision: "deny" });
    expect(JSON.stringify(events)).not.toContain("TOPSECRET-abc123");
  });

  test("grant de sessão não pula a aprovação por comando no host", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const mod = await isolatedRunCommand("host-session-grant");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor, requests } = await hostExecutor(mod, { cwd: dir, approve: () => "session" });
    const call = () => executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo dois" }),
    });
    await call();
    await call();
    expect(requests).toHaveLength(2);
  });

  test("bypass usa o modo do EXECUTOR, não estado global: recusa sem confirmação e executa com ela", async () => {
    mock = installNoDockerSpawnMock({ stdout: "bypass-ok\n" });
    const mod = await isolatedRunCommand("host-bypass");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor, auditPath } = await hostExecutor(mod, { cwd: dir, mode: "bypass" });
    const denied = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo bypass-ok" }),
    });
    expect(denied.isError).toBe(true);
    expect(denied.code).toBe("host_shell_confirmation_required");
    expect(mock.runCalls).toHaveLength(0);
    expect(mock.calls.filter((cmd) => cmd[0] !== "docker")).toHaveLength(0);
    const denyEvent = auditEvents(auditPath).find((event) => event.tipo === "host_shell.decision");
    expect(denyEvent?.payload).toMatchObject({ decision: "deny", reason: "bypass_confirmation_required" });

    const allowed = await executor.run(
      ctxOf(dir, { env: { ...process.env, [HOST_SHELL_BYPASS_CONFIRMATION_ENV]: "1" } }),
      { id: "c2", name: "run_command", arguments: JSON.stringify({ command: "echo bypass-ok" }) },
    );
    expect(allowed.isError).toBeFalsy();
    expect(allowed.output).toContain("bypass-ok");
  });

  test("hard-block vence: comando que toca caminho protegido não chega ao host", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-hard-block");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "cat ~/.astro/vault.json" }),
    });
    expect(result.isError).toBe(true);
    expect(result.code).toBe("path_hard_blocked");
    expect(mock.calls).toHaveLength(0);
  });

  test("saída do host é redigida antes de voltar ao modelo", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    mock = installNoDockerSpawnMock({ stdout: `token=${secret}\n` });
    const mod = await isolatedRunCommand("host-redact");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo token" }),
    });
    expect(result.output).not.toContain(secret);
    expect(result.output).toContain("[REDACTED]");
  });

  test("env do host é sanitizado: nomes de segredo somem, PATH e identidade git ficam", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const mod = await isolatedRunCommand("host-env-sanitized");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(
      ctxOf(dir, {
        env: {
          ...process.env,
          OPENAI_API_KEY: "synthetic-env-value",
          DB_PASSWORD: "db-synthetic",
          AWS_SECRET_ACCESS_KEY: "aws-synthetic",
          GIT_AUTHOR_NAME: "autora",
          PATH: process.env.PATH ?? "",
        },
        secretEnvNames: ["OPENAI_API_KEY"],
      }),
      { id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo ok" }) },
    );
    expect(result.isError).toBeFalsy();
    const env = mock.hostEnvs.at(-1) ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH ?? "");
    expect(env.GIT_AUTHOR_NAME).toBe("autora");
  });

  test("redação roda ANTES do truncamento: segredo cortado na borda não vaza", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    mock = installNoDockerSpawnMock({ stdout: `${"x".repeat(MAX_OUTPUT - 10)}${secret}\n` });
    const mod = await isolatedRunCommand("host-redact-boundary");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const { executor } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo token" }),
    });
    // Truncar primeiro manteria "AKIAABCDEF" na borda; redigir primeiro mascara inteiro.
    expect(result.output).not.toContain("AKIA");
    expect(result.output).toContain("[REDACTED]");
    expect(result.output.length).toBeLessThanOrEqual(MAX_OUTPUT);
  });

  test("shell.default ausente na máquina falha fechado", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const mod = await isolatedRunCommand("host-shell-default");
    mod.configureRunCommand({ mode: "host", shellDefault: "bash" });
    const dir = cwd();
    const { executor } = await hostExecutor(mod, { cwd: dir });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo ok" }),
    });
    // `bash` pode não existir no Windows: falha fechada em vez de trocar de shell em silêncio.
    if (detectHostShells().includes("bash")) {
      expect(result.isError).toBeFalsy();
    } else {
      expect(result.isError).toBe(true);
      expect(result.output).toContain("shell_not_available");
    }
    expect(mock.calls.filter((cmd) => cmd[0] !== "docker").every((cmd) => cmd[0] === "bash" || !cmd.includes("-c"))).toBe(true);
  });
});

describe("limites do host (#474)", () => {
  test("sem configureRunCommand o shell fica desligado (fail-closed)", async () => {
    mock = installNoDockerSpawnMock({ stdout: "não deveria rodar\n" });
    const mod = await isolatedRunCommand("host-unconfigured");
    // Nenhuma configuração: o default do módulo é `disabled`, não `auto`.
    const dir = cwd();
    const { executor } = await hostExecutor(mod, { cwd: dir, approve: () => "session" });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo x" }),
    });
    expect(result.code).toBe("sandbox_required_for_shell");
    expect(mock.calls).toHaveLength(0);
  });

  test("chamada direta sem executor não roda no host (exige allowlist/gate)", async () => {
    mock = installNoDockerSpawnMock({ stdout: "não deveria rodar\n" });
    const mod = await isolatedRunCommand("host-no-executor");
    mod.configureRunCommand({ mode: "host" });
    const result = await mod.runCommandTool.execute({ command: "echo x" }, ctxOf(cwd()));
    expect(result.code).toBe("host_shell_requires_gate");
    expect(mock.runCalls).toHaveLength(0);
    expect(mock.calls.filter((cmd) => cmd[0] !== "docker")).toHaveLength(0);
  });

  test("run_tests runs on the host with the same approval path when the mode is host", async () => {
    mock = installNoDockerSpawnMock({ stdout: "tests ok\n" });
    const mod = await isolatedRunCommand("host-run-tests");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const auditPath = join(dir, ".astro", "audit.jsonl");
    const tool = mod.createRunTestsTool({
      config: { command: ["echo", "test"] },
      audit: new Auditor(auditPath),
    });
    let approvals = 0;
    const executor = new ToolExecutor({
      tools: [tool], allow: ["run_tests"], audit: new Auditor(auditPath), permissionMode: "ask",
      approveTool: () => { approvals++; return "session"; },
    });
    const result = await executor.run(ctxOf(dir), { id: "c1", name: "run_tests", arguments: "{}" });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("tests ok");
    await executor.run(ctxOf(dir), { id: "c2", name: "run_tests", arguments: "{}" });
    // A session answer never suppresses the shell gate: every call asks again.
    expect(approvals).toBe(2);
    expect(mock.calls.some((cmd) => cmd[0] === "docker")).toBe(false);
  });

  test("run_tests refuses a filter that escapes the project on the host", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-run-tests-escape");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const auditPath = join(dir, ".astro", "audit.jsonl");
    const tool = mod.createRunTestsTool({ config: { command: ["echo", "test"] }, audit: new Auditor(auditPath) });
    const executor = new ToolExecutor({
      tools: [tool], allow: ["run_tests"], audit: new Auditor(auditPath), permissionMode: "ask", approveTool: () => true,
    });
    const escaped = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_tests", arguments: JSON.stringify({ filter: "../outside.test.ts" }),
    });
    expect(escaped.code).toBe("external_directory");
    expect(mock.calls).toHaveLength(0);
    const home = await executor.run(ctxOf(dir), {
      id: "c2", name: "run_tests", arguments: JSON.stringify({ filter: "~/vault.json" }),
    });
    expect(home.code).toBe("external_directory");
    expect(mock.calls).toHaveLength(0);
  });

  test("run_tests refuses a symlinked filter that leaves the project", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-run-tests-symlink");
    mod.configureRunCommand({ mode: "host" });
    const dir = cwd();
    const outside = mkdtempSync(join(tmpdir(), "astro-outside-"));
    try {
      symlinkSync(outside, join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // the OS refused the link; nothing to exercise
    }
    const auditPath = join(dir, ".astro", "audit.jsonl");
    const tool = mod.createRunTestsTool({ config: { command: ["echo", "test"] }, audit: new Auditor(auditPath) });
    const executor = new ToolExecutor({
      tools: [tool], allow: ["run_tests"], audit: new Auditor(auditPath), permissionMode: "ask", approveTool: () => true,
    });
    const result = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_tests", arguments: JSON.stringify({ filter: "link/probe.test.ts" }),
    });
    expect(result.code).toBe("external_directory");
    expect(mock.calls).toHaveLength(0);
  });

  test("run_tests with sandbox:true refuses without Docker instead of using the host", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("docker-run-tests-refuse");
    mod.configureRunCommand({ sandbox: true });
    const dir = cwd();
    const auditPath = join(dir, ".astro", "audit.jsonl");
    const tool = mod.createRunTestsTool({ config: { command: ["echo", "test"] }, audit: new Auditor(auditPath) });
    const executor = new ToolExecutor({
      tools: [tool], allow: ["run_tests"], audit: new Auditor(auditPath), permissionMode: "ask", approveTool: () => true,
    });
    const result = await executor.run(ctxOf(dir), { id: "c1", name: "run_tests", arguments: "{}" });
    expect(result.code).toBe("sandbox_required_for_shell");
    expect(mock.runCalls).toHaveLength(0);
  });

  test("run_tests refuses when the shell is off", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("host-run-tests-off");
    mod.configureRunCommand({ sandbox: false });
    const tool = mod.createRunTestsTool({
      config: { command: ["echo", "test"] },
      audit: { append: () => ({}) },
    });
    const result = await tool.execute({}, ctxOf(cwd()));
    expect(result.code).toBe("sandbox_required_for_shell");
    expect(mock.calls).toHaveLength(0);
  });

  test("runCommandTool recusa sandbox=false", async () => {
    const mod = await isolatedRunCommand("host-disabled");
    mod.configureRunCommand({ sandbox: false });
    const result: ToolResult = await mod.runCommandTool.execute({ command: "echo x" }, ctxOf(cwd()));
    expect(result.code).toBe("sandbox_required_for_shell");
  });
});
