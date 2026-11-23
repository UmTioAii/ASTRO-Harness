import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ConfigError, validateConfig } from "../src/core/config";
import { ToolExecutor } from "../src/tools/executor";
import { SHELL_UNPARSABLE, evaluateShellPolicy, scanShellCommand, type ShellRule } from "../src/tools/shell-policy";
import type { ToolContext } from "../src/tools/types";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";

let mock: DockerMock | undefined;
afterEach(() => {
  mock?.restore();
  mock = undefined;
});

const cwdOf = (): string => mkdtempSync(join(tmpdir(), "astro-rules-"));

const ctxOf = (dir: string, extra: Partial<ToolContext> = {}): ToolContext => ({
  cwd: dir, run: "r1", agent: "coder", env: { ...process.env }, ...extra,
});

const auditEvents = (path: string): Record<string, unknown>[] => {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const baseConfig = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

async function hostTool(tag: string, opts: {
  rules?: readonly ShellRule[];
  externalDirectory?: "allow" | "ask" | "deny";
}, mod?: Awaited<ReturnType<typeof isolatedRunCommand>>): Promise<Awaited<ReturnType<typeof isolatedRunCommand>>> {
  const loaded = mod ?? await isolatedRunCommand(tag);
  loaded.configureRunCommand({
    mode: "host",
    ...(opts.rules === undefined ? {} : { rules: opts.rules }),
    ...(opts.externalDirectory === undefined ? {} : { externalDirectory: opts.externalDirectory }),
  });
  return loaded;
}

async function runWith(
  mod: Awaited<ReturnType<typeof isolatedRunCommand>>,
  dir: string,
  command: string,
  opts: { mode?: "ask" | "bypass"; approve?: () => unknown; env?: NodeJS.ProcessEnv } = {},
): Promise<{ result: Awaited<ReturnType<ToolExecutor["run"]>>; requests: unknown[]; auditPath: string }> {
  const auditPath = join(dir, ".astro", "audit.jsonl");
  const requests: unknown[] = [];
  const executor = new ToolExecutor({
    tools: [mod.runCommandTool], allow: ["run_command"], audit: new Auditor(auditPath),
    permissionMode: opts.mode ?? "ask",
    approveTool: (request) => {
      requests.push(request);
      return (opts.approve?.() ?? false) as boolean;
    },
  });
  const result = await executor.run(ctxOf(dir, opts.env === undefined ? {} : { env: opts.env }), {
    id: "c1", name: "run_command", arguments: JSON.stringify({ command }),
  });
  return { result, requests, auditPath };
}

describe("compound command scanner (#599, ADR-0001)", () => {
  test("splits every subcommand and keeps quoted operators literal", () => {
    const scan = scanShellCommand('echo "a && b" && git status; pwd | cat');
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.parts).toEqual(['echo a && b', "git status", "pwd", "cat"]);
  });

  test("refuses dynamic expansion before execution with actionable guidance", () => {
    for (const command of ["echo $(pwd)", "echo $HOME", "echo `pwd`", 'echo "x', "ls &&"]) {
      const scan = scanShellCommand(command);
      expect(scan.ok).toBe(false);
      if (scan.ok) continue;
      expect(scan.code).toBe(SHELL_UNPARSABLE);
      expect(scan.message).toMatch(/literal/i);
    }
  });
});

describe("ordered shell rules and external_directory (#599)", () => {
  const rules: ShellRule[] = [
    { match: "*", effect: "allow" },
    { match: "git push *", effect: "deny" },
  ];

  test("the last matching rule wins", () => {
    const denied = evaluateShellPolicy("git push origin main", "/repo", { rules });
    expect(denied).toMatchObject({ decision: "deny", origin: "rule", trigger: "git push origin main" });
    const allowed = evaluateShellPolicy("git status -s", "/repo", { rules });
    expect(allowed.decision).toBe("allow");
    const reversed = evaluateShellPolicy("git push origin main", "/repo", {
      rules: [{ match: "git push *", effect: "deny" }, { match: "*", effect: "allow" }],
    });
    expect(reversed.decision).toBe("allow"); // order is the user's contract
  });

  test("every subcommand is evaluated and the first denying part is named", () => {
    const result = evaluateShellPolicy("echo ok && rm -rf build", "/repo", {
      rules: [{ match: "echo *", effect: "allow" }, { match: "rm *", effect: "deny" }],
    });
    expect(result).toMatchObject({ decision: "deny", origin: "rule", trigger: "rm -rf build" });
  });

  test("a command the rules do not cover defaults to ask", () => {
    const result = evaluateShellPolicy("whoami", "/repo", { rules: [{ match: "git *", effect: "allow" }] });
    expect(result).toMatchObject({ decision: "ask", origin: "rule", trigger: "whoami" });
  });

  test("external_directory has its own decision, over a rule allow", () => {
    const deny = evaluateShellPolicy("cat ../outside.txt", "/repo", {
      rules: [{ match: "cat *", effect: "allow" }], externalDirectory: "deny",
    });
    expect(deny).toMatchObject({ decision: "deny", origin: "external_directory" });
    const ask = evaluateShellPolicy("cat ../outside.txt", "/repo", {
      rules: [{ match: "cat *", effect: "allow" }], externalDirectory: "ask",
    });
    expect(ask).toMatchObject({ decision: "ask", origin: "external_directory", trigger: "cat ../outside.txt" });
    const inside = evaluateShellPolicy("cat ./README.md", "/repo", {
      rules: [{ match: "cat *", effect: "allow" }], externalDirectory: "deny",
    });
    expect(inside.decision).toBe("allow");
  });
});

describe("shell rules at the gate (#599)", () => {
  test("a deny rule cannot be overridden by bypass", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await hostTool("rules-bypass-deny", { rules: [{ match: "echo *", effect: "deny" }] });
    const dir = cwdOf();
    const { result } = await runWith(mod, dir, "echo secret", {
      mode: "bypass", env: { ...process.env, ASTRO_HOST_SHELL_BYPASS_CONFIRM: "1" },
    });
    expect(result.isError).toBe(true);
    expect(result.code).toBe("shell_rule_denied");
    expect(mock.calls).toHaveLength(0);
  });

  test("a saved session approval never overrides a deny rule", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await hostTool("rules-session-deny", {
      rules: [{ match: "echo secret *", effect: "deny" }, { match: "*", effect: "ask" }],
    });
    const dir = cwdOf();
    const auditPath = join(dir, ".astro", "audit.jsonl");
    const requests: unknown[] = [];
    const executor = new ToolExecutor({
      tools: [mod.runCommandTool], allow: ["run_command"], audit: new Auditor(auditPath),
      permissionMode: "ask", approveTool: (request) => { requests.push(request); return "session"; },
    });
    const first = await executor.run(ctxOf(dir), {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo ok" }),
    });
    expect(first.isError).toBeFalsy();
    const denied = await executor.run(ctxOf(dir), {
      id: "c2", name: "run_command", arguments: JSON.stringify({ command: "echo secret x" }),
    });
    expect(denied.code).toBe("shell_rule_denied");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(auditEvents(auditPath))).not.toContain("echo secret x");
  });

  test("a compound command asks once and names the part that triggered it", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await hostTool("rules-compound-ask", {
      rules: [{ match: "echo *", effect: "allow" }, { match: "rm *", effect: "ask" }],
    });
    const dir = cwdOf();
    const { result, requests } = await runWith(mod, dir, "echo ok && rm -rf build");
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(1);
    const detail = (requests[0] as { detail?: { value: string } }).detail;
    expect(detail?.value).toContain("rm -rf build");
    expect(detail?.value).toContain("echo ok");
    expect(mock.calls).toHaveLength(0);
  });

  test("an unparsable command is refused before execution, even in bypass", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await hostTool("rules-unparsable", { rules: [{ match: "*", effect: "allow" }] });
    const dir = cwdOf();
    const { result } = await runWith(mod, dir, "echo $(pwd)", {
      mode: "bypass", env: { ...process.env, ASTRO_HOST_SHELL_BYPASS_CONFIRM: "1" },
    });
    expect(result.isError).toBe(true);
    expect(result.code).toBe(SHELL_UNPARSABLE);
    expect(result.output).toMatch(/literal/i);
    expect(mock.calls).toHaveLength(0);
  });

  test("an allow rule skips the approval prompt", async () => {
    mock = installNoDockerSpawnMock({ stdout: "allowed\n" });
    const mod = await hostTool("rules-allow", { rules: [{ match: "echo *", effect: "allow" }] });
    const dir = cwdOf();
    const { result, requests } = await runWith(mod, dir, "echo allowed");
    expect(result.isError).toBeFalsy();
    expect(requests).toHaveLength(0);
  });

  test("external_directory asks even when the rule allows the command", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await hostTool("rules-external", {
      rules: [{ match: "*", effect: "allow" }], externalDirectory: "ask",
    });
    const dir = cwdOf();
    const { result, requests } = await runWith(mod, dir, "cat ../outside.txt");
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(1);
    expect(mock.calls).toHaveLength(0);
  });

  test("an in-project target stays inside the project decision", async () => {
    mock = installNoDockerSpawnMock({ stdout: "content\n" });
    const mod = await hostTool("rules-external-inside", {
      rules: [{ match: "cat *", effect: "allow" }], externalDirectory: "deny",
    });
    const dir = cwdOf();
    writeFileSync(join(dir, "README.md"), "content\n");
    const { result } = await runWith(mod, dir, "cat ./README.md");
    expect(result.isError).toBeFalsy();
  });
});

describe("shell config (#599)", () => {
  test("accepts ordered rules and externalDirectory", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.shell = {
      mode: "host",
      rules: [{ match: "git status *", effect: "allow" }, { match: "*", effect: "ask" }],
      externalDirectory: "deny",
    };
    const cfg = validateConfig(raw);
    expect(cfg.shell?.rules).toEqual([
      { match: "git status *", effect: "allow" }, { match: "*", effect: "ask" },
    ]);
    expect(cfg.shell?.externalDirectory).toBe("deny");
  });

  test("rejects an unknown effect, an empty match and an unknown key", () => {
    const withRules = (rules: unknown, externalDirectory?: unknown): Record<string, unknown> => {
      const raw = structuredClone(baseConfig) as Record<string, unknown>;
      raw.shell = { rules, ...(externalDirectory === undefined ? {} : { externalDirectory }) };
      return raw;
    };
    expect(() => validateConfig(withRules([{ match: "*", effect: "permit" }]))).toThrow(ConfigError);
    expect(() => validateConfig(withRules([{ match: "", effect: "allow" }]))).toThrow(ConfigError);
    expect(() => validateConfig(withRules([], "maybe"))).toThrow(ConfigError);
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.shell = { rules: [], approval: "always" };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });
});
