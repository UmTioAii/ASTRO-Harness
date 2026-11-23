import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auditor } from "../src/audit";
import { ConfigError, validateConfig } from "../src/core/config";
import { ToolExecutor } from "../src/tools/executor";
import { SHELL_UNPARSABLE, evaluateShellPolicy, scanShellCommand, type ShellRule } from "../src/tools/shell-policy";
import type { ToolContext } from "../src/tools/types";
import { HOST_SHELL_BYPASS_CONFIRMATION_ENV } from "../src/tools/run-command";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";

let mock: DockerMock | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });
type Mod = Awaited<ReturnType<typeof isolatedRunCommand>>;
const cwdOf = (): string => mkdtempSync(join(tmpdir(), "astro-rules-"));
const ctxOf = (cwd: string, extra: Partial<ToolContext> = {}): ToolContext =>
  ({ cwd, run: "r1", agent: "coder", env: { ...process.env }, ...extra });
const base = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};
async function hostTool(tag: string, opts: { rules?: readonly ShellRule[]; externalDirectory?: "allow" | "ask" | "deny" }): Promise<Mod> {
  const mod = await isolatedRunCommand(tag);
  mod.configureRunCommand({ mode: "host", ...opts });
  return mod;
}
async function runWith(mod: Mod, cwd: string, command: string, opts: {
  mode?: "ask" | "bypass"; approve?: () => unknown; env?: NodeJS.ProcessEnv;
} = {}) {
  const auditPath = join(cwd, ".astro", "audit.jsonl");
  const requests: unknown[] = [];
  const executor = new ToolExecutor({
    tools: [mod.runCommandTool], allow: ["run_command"], audit: new Auditor(auditPath),
    permissionMode: opts.mode ?? "ask",
    approveTool: (request) => { requests.push(request); return (opts.approve?.() ?? false) as boolean; },
  });
  const result = await executor.run(ctxOf(cwd, opts.env === undefined ? {} : { env: opts.env }), {
    id: "c1", name: "run_command", arguments: JSON.stringify({ command }),
  });
  return { result, requests, auditPath };
}

describe("compound command scanner (#599, ADR-0001)", () => {
  test("splits subcommands, keeps quoted operators and refuses dynamic expansion", () => {
    const scan = scanShellCommand('echo "a && b" && git status; pwd | cat');
    expect(scan.ok && scan.parts).toEqual(["echo a && b", "git status", "pwd", "cat"]);
    for (const command of ["echo $(pwd)", "echo $HOME", "echo `pwd`", 'echo "x', "ls &&"]) {
      const refused = scanShellCommand(command);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused).toMatchObject({ code: SHELL_UNPARSABLE });
      if (!refused.ok) expect(refused.message).toMatch(/literal/i);
    }
  });
  test("covers ||, &, newlines and subshells", () => {
    const compound = scanShellCommand("a || b & c\nd");
    expect(compound.ok && compound.parts).toEqual(["a", "b", "c", "d"]);
    const subshell = scanShellCommand("(a && b)");
    expect(subshell.ok && subshell.parts).toEqual(["a", "b"]);
  });
  test("refuses cmd expansion while single quotes keep a literal percent", () => {
    expect(scanShellCommand("echo '%PATH%'").ok).toBe(true);
    for (const command of ["echo %NAME:~0%", "echo %%i", "cat %USERPROFILE:~0%\\notes.txt"]) {
      expect(scanShellCommand(command).ok).toBe(false);
    }
  });
  test("keeps backslashes in Windows paths, quoted paths and ..\\..\\ escapes", () => {
    const plain = scanShellCommand("cat C:\\Windows\\win.ini");
    const quoted = scanShellCommand('cat "C:\\Program Files\\x.txt"');
    const relative = scanShellCommand("cat ..\\..\\secret.txt");
    if (process.platform !== "win32") return; // POSIX keeps its escape semantics
    expect(plain.ok && plain.words[0]).toEqual(["cat", "C:\\Windows\\win.ini"]);
    expect(quoted.ok && quoted.words[0]).toEqual(["cat", "C:\\Program Files\\x.txt"]);
    expect(relative.ok && relative.words[0]).toEqual(["cat", "..\\..\\secret.txt"]);
  });
});

describe("ordered rules and external_directory (#599)", () => {
  test("last match wins; every part is evaluated; uncovered parts ask", () => {
    const rules: ShellRule[] = [{ match: "*", effect: "allow" }, { match: "git push *", effect: "deny" }];
    expect(evaluateShellPolicy("git push origin main", "/repo", { rules }))
      .toMatchObject({ decision: "deny", origin: "rule", trigger: "git push origin main" });
    expect(evaluateShellPolicy("git status -s", "/repo", { rules }).decision).toBe("allow");
    expect(evaluateShellPolicy("git push x", "/repo", {
      rules: [{ match: "git push *", effect: "deny" }, { match: "*", effect: "allow" }],
    }).decision).toBe("allow"); // order is the user's contract
    expect(evaluateShellPolicy("echo ok && rm -rf build", "/repo", {
      rules: [{ match: "echo *", effect: "allow" }, { match: "rm *", effect: "deny" }],
    })).toMatchObject({ decision: "deny", trigger: "rm -rf build" });
    expect(evaluateShellPolicy("whoami", "/repo", { rules: [{ match: "git *", effect: "allow" }] }))
      .toMatchObject({ decision: "ask", trigger: "whoami" });
  });
  test("external_directory has its own decision over a rule allow", () => {
    const rules: ShellRule[] = [{ match: "cat *", effect: "allow" }];
    expect(evaluateShellPolicy("cat ../outside.txt", "/repo", { rules, externalDirectory: "deny" }))
      .toMatchObject({ decision: "deny", origin: "external_directory" });
    expect(evaluateShellPolicy("cat ../outside.txt", "/repo", { rules, externalDirectory: "ask" }))
      .toMatchObject({ decision: "ask", origin: "external_directory" });
    expect(evaluateShellPolicy("cat ./README.md", "/repo", { rules, externalDirectory: "deny" }).decision).toBe("allow");
  });
  test("a trailing ' *' also matches the bare prefix", () => {
    const rules: ShellRule[] = [{ match: "*", effect: "allow" }, { match: "git push *", effect: "deny" }];
    expect(evaluateShellPolicy("git push", "/repo", { rules })).toMatchObject({ decision: "deny", origin: "rule" });
    expect(evaluateShellPolicy("git push origin main", "/repo", { rules }).decision).toBe("deny");
    expect(evaluateShellPolicy("git status", "/repo", { rules }).decision).toBe("allow");
  });
  test("--flag= values, cd, .., ~ and absolute targets are external", () => {
    const rules: ShellRule[] = [{ match: "*", effect: "allow" }];
    const policy = { rules, externalDirectory: "deny" as const };
    const repo = resolve(tmpdir(), "astro-policy-repo");
    const outside = resolve(tmpdir(), "astro-policy-outside", "notes.txt");
    expect(evaluateShellPolicy(`cat --file=${outside}`, repo, policy)).toMatchObject({ decision: "deny", origin: "external_directory" });
    expect(evaluateShellPolicy("tar --directory=../x", repo, policy).decision).toBe("deny");
    expect(evaluateShellPolicy("git --git-dir=../.git log", repo, policy).decision).toBe("deny");
    expect(evaluateShellPolicy("cd .. && cat x", repo, policy).decision).toBe("deny");
    expect(evaluateShellPolicy("cat ..", repo, policy).decision).toBe("deny");
    expect(evaluateShellPolicy("cat ~/notes.txt", repo, policy).decision).toBe("deny");
    expect(evaluateShellPolicy(`cat ${outside}`, repo, policy).decision).toBe("deny");
    expect(evaluateShellPolicy("cd sub && cat a.txt", repo, policy).decision).toBe("allow");
    if (process.platform === "win32") {
      expect(evaluateShellPolicy("cat C:\\Windows\\win.ini", repo, policy).decision).toBe("deny");
      expect(evaluateShellPolicy("cat ..\\..\\secret.txt", repo, policy).decision).toBe("deny");
    }
  });
  test("symlink escapes are external and a symlinked project root stays inside", () => {
    const rules: ShellRule[] = [{ match: "cat *", effect: "allow" }];
    const policy = { rules, externalDirectory: "deny" as const };
    const root = mkdtempSync(join(tmpdir(), "astro-rules-link-"));
    const real = join(root, "project");
    mkdirSync(join(real, "sub"), { recursive: true });
    writeFileSync(join(real, "sub", "a.txt"), "x");
    const linkedProject = join(root, "project-link");
    symlinkSync(real, linkedProject, process.platform === "win32" ? "junction" : "dir");
    expect(evaluateShellPolicy("cat sub/a.txt", linkedProject, policy).decision).toBe("allow");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.txt"), "x");
    symlinkSync(outside, join(real, "link"), process.platform === "win32" ? "junction" : "dir");
    expect(evaluateShellPolicy("cat link/a.txt", linkedProject, policy)).toMatchObject({
      decision: "deny", origin: "external_directory",
    });
  });
});

describe("shell rules at the gate (#599)", () => {
  test("a deny rule survives bypass and a saved approval", async () => {
    mock = installNoDockerSpawnMock();
    const cwd = cwdOf();
    const deny = await hostTool("rules-bypass-deny", { rules: [{ match: "echo *", effect: "deny" }] });
    const bypass = await runWith(deny, cwd, "echo secret", {
      mode: "bypass", env: { ...process.env, [HOST_SHELL_BYPASS_CONFIRMATION_ENV]: "1" },
    });
    expect(bypass.result.code).toBe("shell_rule_denied");
    expect(mock.calls).toHaveLength(0);
    const mod = await hostTool("rules-session-deny", {
      rules: [{ match: "*", effect: "ask" }, { match: "echo secret *", effect: "deny" }],
    });
    const auditPath = join(cwd, ".astro", "audit.jsonl");
    const requests: unknown[] = [];
    const executor = new ToolExecutor({
      tools: [mod.runCommandTool], allow: ["run_command"], audit: new Auditor(auditPath), permissionMode: "ask",
      approveTool: (request) => { requests.push(request); return "session"; },
    });
    await executor.run(ctxOf(cwd), { id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo ok" }) });
    const denied = await executor.run(ctxOf(cwd), {
      id: "c2", name: "run_command", arguments: JSON.stringify({ command: "echo secret x" }),
    });
    expect(denied.code).toBe("shell_rule_denied");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(readFileSync(auditPath, "utf8"))).not.toContain("echo secret x");
  });
  test("a compound command asks once and names the triggering part", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await hostTool("rules-compound", {
      rules: [{ match: "echo *", effect: "allow" }, { match: "rm *", effect: "ask" }],
    });
    const { result, requests } = await runWith(mod, cwdOf(), "echo ok && rm -rf build");
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(1);
    const detail = (requests[0] as { detail?: { value: string } }).detail;
    expect(detail?.value).toContain("echo ok");
    expect(detail?.value).toContain("rm -rf build");
    expect(mock.calls).toHaveLength(0);
  });
  test("unparsable is refused before execution; an allow rule skips the prompt", async () => {
    mock = installNoDockerSpawnMock({ stdout: "allowed\n" });
    const allowed = await runWith(await hostTool("rules-allow", { rules: [{ match: "echo *", effect: "allow" }] }), cwdOf(), "echo allowed");
    expect(allowed.result.isError).toBeFalsy();
    expect(allowed.requests).toHaveLength(0);
    const refused = await runWith(await hostTool("rules-unparsable", { rules: [{ match: "*", effect: "allow" }] }), cwdOf(), "echo $(pwd)", {
      mode: "bypass", env: { ...process.env, [HOST_SHELL_BYPASS_CONFIRMATION_ENV]: "1" },
    });
    expect(refused.result).toMatchObject({ code: SHELL_UNPARSABLE });
    expect(refused.result.output).toMatch(/literal/i);
  });
  test("bypass only runs on the explicit confirmation and still asks nothing", async () => {
    mock = installNoDockerSpawnMock({ stdout: "bypass-ok\n" });
    const mod = await hostTool("rules-bypass-allow", { rules: [{ match: "echo *", effect: "allow" }] });
    const cwd = cwdOf();
    const blocked = await runWith(mod, cwd, "echo ok", { mode: "bypass" });
    expect(blocked.result.code).toBe("host_shell_confirmation_required");
    const allowed = await runWith(mod, cwd, "echo ok", {
      mode: "bypass", env: { ...process.env, [HOST_SHELL_BYPASS_CONFIRMATION_ENV]: "1" },
    });
    expect(allowed.result.isError).toBeFalsy();
    expect(allowed.requests).toHaveLength(0);
  });
  test("the gate refuses --flag= and cd escapes before any spawn", async () => {
    mock = installNoDockerSpawnMock();
    const cwd = cwdOf();
    const outside = resolve(tmpdir(), "astro-gate-outside", "notes.txt");
    const flag = await runWith(
      await hostTool("rules-gate-flag", { rules: [{ match: "*", effect: "allow" }], externalDirectory: "deny" }),
      cwd, `cat --file=${outside}`,
    );
    expect(flag.result.code).toBe("external_directory");
    const cd = await runWith(
      await hostTool("rules-gate-cd", { rules: [{ match: "*", effect: "allow" }], externalDirectory: "deny" }),
      cwd, "cd .. && cat notes.txt",
    );
    expect(cd.result.code).toBe("external_directory");
    expect(mock.calls).toHaveLength(0);
  });
  test("a rule allow is audited with its origin", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = cwdOf();
    const mod = await hostTool("rules-origin", { rules: [{ match: "echo *", effect: "allow" }] });
    const { result, auditPath } = await runWith(mod, cwd, "echo ok");
    expect(result.isError).toBeFalsy();
    const events = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const decision = events.find((event: { tipo: string }) => event.tipo === "permission.decision");
    expect(decision?.payload).toMatchObject({ decision: "allow", origin: "rule" });
  });
  test("external_directory asks over a rule allow; in-project targets stay allowed", async () => {
    mock = installNoDockerSpawnMock({ stdout: "content\n" });
    const outside = await hostTool("rules-external", { rules: [{ match: "*", effect: "allow" }], externalDirectory: "ask" });
    expect((await runWith(outside, cwdOf(), "cat ../outside.txt")).requests).toHaveLength(1);
    const inside = await hostTool("rules-inside", { rules: [{ match: "cat *", effect: "allow" }], externalDirectory: "deny" });
    const cwd = cwdOf();
    writeFileSync(join(cwd, "README.md"), "content\n");
    const result = await runWith(inside, cwd, "cat ./README.md");
    expect(result.result.isError).toBeFalsy();
    expect(result.requests).toHaveLength(0);
  });
});

describe("shell config (#599)", () => {
  test("accepts rules and externalDirectory; rejects bad values and unknown keys", () => {
    const withShell = (shell: unknown): Record<string, unknown> => ({ ...structuredClone(base), shell });
    expect(validateConfig(withShell({
      mode: "host", rules: [{ match: "git status *", effect: "allow" }, { match: "*", effect: "ask" }], externalDirectory: "deny",
    })).shell).toMatchObject({ externalDirectory: "deny" });
    expect(() => validateConfig(withShell({ rules: [{ match: "*", effect: "permit" }] }))).toThrow(ConfigError);
    expect(() => validateConfig(withShell({ rules: [], externalDirectory: "maybe" }))).toThrow(ConfigError);
    expect(() => validateConfig(withShell({ rules: [], approval: "always" }))).toThrow(ConfigError);
  });
});
