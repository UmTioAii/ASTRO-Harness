import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { toolChoice, toolPrompt } from "../src/chat/approvers";
import { validateConfig } from "../src/core/config";
import { ToolExecutor } from "../src/tools/executor";
import type { ToolContext } from "../src/tools/types";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";

let mock: DockerMock | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });

type Mod = Awaited<ReturnType<typeof isolatedRunCommand>>;
const dirOf = (): string => mkdtempSync(join(tmpdir(), "astro-always-"));
const ctxOf = (cwd: string): ToolContext => ({ cwd, run: "r1", agent: "coder", env: { ...process.env } });

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

describe("approval vocabulary once/always/reject (#599)", () => {
  test("toolChoice maps s/once, a/always and r/reject", () => {
    expect(toolChoice("s")).toBe("once");
    expect(toolChoice("a")).toBe("always");
    expect(toolChoice("r")).toBe("reject");
    expect(toolChoice("S")).toBe("always"); // legacy grant spelling
    expect(toolChoice("n")).toBe(false);
  });

  test("the prompt names once/always/reject but not always per call", () => {
    const prompt = toolPrompt({ name: "run_command", action: "shell", mode: "ask" });
    for (const choice of ["once", "always", "reject"]) expect(prompt).toContain(choice);
    const perCall = toolPrompt({ name: "run_command", action: "shell", mode: "ask", perCall: true });
    expect(perCall).not.toContain("[a]");
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
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as { shell?: { approvals?: unknown } };
    expect(saved.shell?.approvals).toEqual([{ match: "echo *", effect: "allow" }]);
    const second = await run(mod, cwd, "echo ok", () => "always", "c2");
    expect(second.result.isError).toBeFalsy();
    expect(second.requests).toHaveLength(0);
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
});

describe("reject cancels the pending approvals of the session (#599)", () => {
  test("denies, clears session grants and audits the rejection", async () => {
    mock = installNoDockerSpawnMock();
    const cwd = dirOf();
    const mod = await isolatedRunCommand("reject-clear");
    mod.configureRunCommand({ mode: "host" });
    const { executor, result, auditPath } = await run(mod, cwd, "echo no", () => "reject");
    expect(result).toMatchObject({ isError: true, failure: "denied" });
    expect(executor.permissionGrants.has("read_common:read_file")).toBe(false);
    const raw = readFileSync(auditPath, "utf8");
    expect(raw).toContain('"reason":"rejected"');
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
