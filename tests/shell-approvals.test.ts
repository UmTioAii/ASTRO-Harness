import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { chatApprovers, toolChoice, toolPrompt } from "../src/chat/approvers";
import { validateConfig } from "../src/core/config";
import { ToolExecutor } from "../src/tools/executor";
import { configureRunCommand, runCommandTool } from "../src/tools/run-command";
import { approvalPattern } from "../src/tools/shell-policy";
import { approvalSaveProblem } from "../src/tools/shell-approvals";
import type { Tool, ToolContext } from "../src/tools/types";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";

let mock: DockerMock | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });

type Mod = Awaited<ReturnType<typeof isolatedRunCommand>>;
const dirOf = (): string => mkdtempSync(join(tmpdir(), "astro-always-"));
const ctxOf = (cwd: string): ToolContext => ({ cwd, run: "r1", agent: "coder", env: { ...process.env } });

function auditEvents(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function run(mod: Mod, cwd: string, command: string, approve: () => unknown, id = "c1") {
  const auditPath = join(cwd, ".astro", "audit.jsonl");
  const requests: unknown[] = [];
  const executor = new ToolExecutor({
    tools: [mod.runCommandTool], allow: ["run_command"], audit: new Auditor(auditPath), permissionMode: "ask",
    approveTool: (request) => { requests.push(request); return approve() as boolean; },
  });
  const result = await executor.run(ctxOf(cwd), { id, name: "run_command", arguments: JSON.stringify({ command }) });
  return { executor, result, requests, auditPath };
}

const approvalsOf = (configPath: string): unknown => {
  const saved = JSON.parse(readFileSync(configPath, "utf8")) as { shell?: { approvals?: unknown } };
  return saved.shell?.approvals;
};

describe("approval vocabulary once/always/reject (#599)", () => {
  test("toolChoice maps s/once, a/always and r/reject", () => {
    expect(toolChoice("s")).toBe("once");
    expect(toolChoice("a")).toBe("always");
    expect(toolChoice("r")).toBe("reject");
    expect(toolChoice("a", true)).toBe("always"); // per call still saves a prefix rule
    expect(toolChoice("S", true)).toBe(true); // legacy spelling stays call-scoped
    expect(toolChoice("S")).toBe("always");
    expect(toolChoice("n")).toBe(false);
  });

  test("both prompts name once/always/reject", () => {
    const prompt = toolPrompt({ name: "run_command", action: "shell", mode: "ask" });
    for (const choice of ["once", "always", "reject"]) expect(prompt).toContain(choice);
    const perCall = toolPrompt({ name: "run_command", action: "shell", mode: "ask", perCall: true });
    expect(perCall).toContain("[a]");
    expect(perCall).toContain("reject");
  });

  test("the REPL accepts always for a per-call shell prompt", async () => {
    const io = { read: async () => "a", write: () => {} };
    const answer = await chatApprovers(io, true).approveTool!({
      name: "run_command", action: "shell", mode: "ask", perCall: true,
    });
    expect(answer).toBe("always");
  });
});

describe("always writes a prefix rule in the project layer (#599)", () => {
  test("the second identical invocation does not ask and the config holds the approval", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = dirOf();
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, "{}\n");
    const mod = await isolatedRunCommand("always-persist");
    mod.configureRunCommand({ mode: "host", configPath, rules: [{ match: "*", effect: "ask" }] });

    const first = await run(mod, cwd, "echo ok", () => "always", "c1");
    expect(first.result.isError).toBeFalsy();
    expect(first.requests).toHaveLength(1);
    expect(approvalsOf(configPath)).toEqual([{ match: "echo *", effect: "allow" }]);
    const second = await run(mod, cwd, "echo ok", () => "always", "c2");
    expect(second.result.isError).toBeFalsy();
    expect(second.requests).toHaveLength(0);
  });

  test("a wildcard in the head is refused instead of becoming a saved wildcard rule", async () => {
    for (const command of ["* --version", "g* status"]) {
      expect(approvalPattern(command)).toBeUndefined();
      mock?.restore();
      mock = installNoDockerSpawnMock({ stdout: "ok\n" });
      const cwd = dirOf();
      const configPath = join(cwd, "astro.config.json");
      writeFileSync(configPath, "{}\n");
      const mod = await isolatedRunCommand(`wild-${command.replace(/\W/g, "")}`);
      mod.configureRunCommand({ mode: "host", configPath, rules: [{ match: "*", effect: "ask" }] });
      const first = await run(mod, cwd, command, () => "always");
      expect(approvalsOf(configPath)).toBeUndefined();
      expect(first.result.output).toContain("not saved");
      const second = await run(mod, cwd, command, () => "always", "c2");
      expect(second.requests).toHaveLength(1); // still asks: no durable grant
    }
  });

  test("a configured deny is never overridden by a saved approval", async () => {
    mock = installNoDockerSpawnMock();
    const cwd = dirOf();
    writeFileSync(join(cwd, "astro.config.json"), "{}\n");
    const mod = await isolatedRunCommand("always-deny");
    mod.configureRunCommand({
      mode: "host", configPath: join(cwd, "astro.config.json"),
      rules: [{ match: "git *", effect: "ask" }, { match: "git push *", effect: "deny" }],
    });
    const denied = await run(mod, cwd, "git push origin main", () => "always");
    expect(denied.result.code).toBe("shell_rule_denied");
    expect(denied.requests).toHaveLength(0);
  });

  test("always saves the subcommand that triggered the ask, not the first one", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = dirOf();
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, "{}\n");
    const mod = await isolatedRunCommand("always-trigger");
    mod.configureRunCommand({
      mode: "host", configPath,
      rules: [{ match: "*", effect: "ask" }, { match: "git *", effect: "allow" }],
    });
    const first = await run(mod, cwd, "git status && rm -rf build", () => "always");
    expect(first.requests).toHaveLength(1);
    expect(approvalsOf(configPath)).toEqual([{ match: "rm *", effect: "allow" }]);
    const second = await run(mod, cwd, "git status && rm -rf build", () => "always", "c2");
    expect(second.requests).toHaveLength(0);
  });

  test("always refuses when more than one subcommand needs a decision", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = dirOf();
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, "{}\n");
    const mod = await isolatedRunCommand("always-multi");
    mod.configureRunCommand({ mode: "host", configPath, rules: [{ match: "*", effect: "ask" }] });
    const first = await run(mod, cwd, "echo a | cat", () => "always");
    expect(first.requests).toHaveLength(1);
    expect(approvalsOf(configPath)).toBeUndefined();
    expect(first.result.output).toContain("not saved");
    const second = await run(mod, cwd, "echo a | cat", () => "always", "c2");
    expect(second.requests).toHaveLength(1);
  });
});

describe("reject cancels the pending approvals of the session (#599)", () => {
  test("denies, clears a real session grant and the next non-shell call asks again", async () => {
    mock = installNoDockerSpawnMock();
    const cwd = dirOf();
    const mod = await isolatedRunCommand("reject-clear");
    mod.configureRunCommand({ mode: "host" });
    const auditPath = join(cwd, ".astro", "audit.jsonl");
    const editTool: Tool = {
      manifest: {
        name: "write_file", description: "fake edit", parameters: { type: "object", properties: {} },
        risk: "low", permission: "write", class: "edit", timeoutMs: 1_000,
        retryable: false, idempotent: false, sideEffects: "filesystem",
      },
      async execute() { return { output: "written" }; },
    };
    const requests: unknown[] = [];
    const executor = new ToolExecutor({
      tools: [mod.runCommandTool, editTool], allow: ["run_command", "write_file"],
      audit: new Auditor(auditPath), permissionMode: "ask",
      approveTool: (request) => { requests.push(request); return "reject"; },
    });
    const ctx = ctxOf(cwd);
    executor.permissionGrants.grant("edit:write_file");
    const result = await executor.run(ctx, {
      id: "c1", name: "run_command", arguments: JSON.stringify({ command: "echo no" }),
    });
    expect(result).toMatchObject({ isError: true, failure: "denied" });
    expect(executor.permissionGrants.has("edit:write_file")).toBe(false);
    expect(readFileSync(auditPath, "utf8")).toContain('"reason":"rejected"');
    // The seeded grant is gone: the next edit asks instead of being allowed silently.
    await executor.run(ctx, { id: "c2", name: "write_file", arguments: "{}" });
    expect(requests.some((request) => (request as { name?: string }).name === "write_file")).toBe(true);
  });
});

describe("the legacy session answer never creates a durable grant (#599)", () => {
  test("an approver returning session keeps the call scoped", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = dirOf();
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, "{}\n");
    const mod = await isolatedRunCommand("legacy-session");
    mod.configureRunCommand({ mode: "host", configPath, rules: [{ match: "*", effect: "ask" }] });
    const first = await run(mod, cwd, "echo ok", () => "session");
    expect(first.result.isError).toBeFalsy();
    expect(approvalsOf(configPath)).toBeUndefined();
    const second = await run(mod, cwd, "echo ok", () => "session", "c2");
    expect(second.requests).toHaveLength(1); // asked again
  });
});

describe("every decision records the grant scope and a saved approval (#599)", () => {
  test("once and always are distinguishable and the persisted pattern is audited", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = dirOf();
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, "{}\n");
    const mod = await isolatedRunCommand("audit-grant");
    mod.configureRunCommand({ mode: "host", configPath, rules: [{ match: "*", effect: "ask" }] });

    const once = await run(mod, cwd, "echo one", () => "once", "c1");
    const onceEvents = auditEvents(once.auditPath);
    expect(onceEvents.find((event) => event.tipo === "permission.decision")?.payload)
      .toMatchObject({ decision: "allow", grant: "once" });
    expect(onceEvents.some((event) => event.tipo === "shell.approval.saved")).toBe(false);

    const always = await run(mod, cwd, "echo two", () => "always", "c2");
    const alwaysEvents = auditEvents(always.auditPath);
    const lastDecision = alwaysEvents.filter((event) => event.tipo === "permission.decision").at(-1);
    expect(lastDecision?.payload).toMatchObject({ decision: "allow", grant: "always" });
    expect(alwaysEvents.find((event) => event.tipo === "shell.approval.saved")?.payload)
      .toEqual({ pattern: "echo *", origin: "approval" });
    expect(JSON.stringify(alwaysEvents)).not.toContain("echo two");
  });

  test("a failed persist tells the user instead of silently degrading", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const cwd = dirOf();
    const mod = await isolatedRunCommand("no-config-path");
    mod.configureRunCommand({ mode: "host", rules: [{ match: "*", effect: "ask" }] });
    const { result } = await run(mod, cwd, "echo ok", () => "always");
    expect(result.output).toContain("not saved");
  });
});

describe("shell.approvals config (#599)", () => {
  test("accepts approvals with the same vocabulary as rules", () => {
    const raw = {
      providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
      models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
      agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      shell: { approvals: [{ match: "echo *", effect: "allow" }] },
    };
    expect(validateConfig(raw).shell?.approvals).toEqual([{ match: "echo *", effect: "allow" }]);
  });
});

test("a prefix hiding a secret behind an invisible character is refused (#650)", () => {
  const dir = dirOf();
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, "{}");
  expect(approvalSaveProblem("sk-\u200Blive-abcdefghijklmnop *", configPath)).toContain("secret");
});

test("a prefix carrying a zero-width joiner is refused, not persisted (#650)", () => {
  const dir = dirOf();
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, "{}");
  // Fail-safe: the sanitizer cannot tell a ZWJ emoji from a hidden secret, so
  // `always` degrades to once instead of writing the raw prefix.
  expect(approvalSaveProblem("\u{1F468}\u200D\u{1F469}\u200D\u{1F467} *", configPath))
    .toContain("secret");
});

test("always degrades instead of saving outside the host transport (#650)", async () => {
  const mod = await isolatedRunCommand("always-disabled");
  const dir = dirOf();
  const configPath = join(dir, "astro.config.json");
  mod.configureRunCommand({ mode: "disabled", configPath });
  const saved = mod.runCommandTool.rememberApproval!({ command: "git push origin main" }, ctxOf(dir));
  expect(saved).toMatchObject({ ok: false, reason: expect.stringContaining("transport") });
});
