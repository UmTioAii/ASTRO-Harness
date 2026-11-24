import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { HOST_SHELL_BYPASS_CONFIRMATION_ENV } from "../src/tools/run-command";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";
import { listShellDecisions, shellHarness } from "./helpers/shell-harness";

let mock: DockerMock | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });

const hashOf = (payload: Record<string, unknown> | undefined): string => String(payload?.commandHash);
const auditText = (path: string): string => readFileSync(path, "utf8");

describe("host_shell.decision audit (#599, D-11, I-03)", () => {
  test("a rule allow is audited with commandHash, effect and origin, never the command or the output", async () => {
    mock = installNoDockerSpawnMock({ stdout: "STDOUTMARK_ALLOW\n" });
    const harness = await shellHarness(await isolatedRunCommand("audit-rule-allow"), {
      rules: [{ match: "echo *", effect: "allow" }],
    });
    const result = await harness.run("echo CMDMARK_ALLOW");
    expect(result.isError).toBeFalsy();
    const [gate, execution] = listShellDecisions(harness.auditPath);
    expect(gate).toMatchObject({ tool: "run_command", stage: "gate", effect: "allow", origin: "rule" });
    expect(hashOf(gate)).toMatch(/^[a-f0-9]{16}$/);
    // The execution stage records the transport and the shell that was actually selected.
    expect(execution).toMatchObject({ tool: "run_command", stage: "execution", effect: "allow", transport: "host" });
    expect(typeof execution?.shell).toBe("string");
    expect(execution?.commandHash).toBe(gate?.commandHash);
    expect(auditText(harness.auditPath)).not.toContain("CMDMARK_ALLOW");
    expect(auditText(harness.auditPath)).not.toContain("STDOUTMARK_ALLOW");
  });

  test("an ask is audited before the answer and the approval carries grant and origin", async () => {
    mock = installNoDockerSpawnMock({ stdout: "STDOUTMARK_ASK\n" });
    const harness = await shellHarness(await isolatedRunCommand("audit-ask"), {
      rules: [{ match: "*", effect: "ask" }],
      approve: () => "once",
    });
    expect((await harness.run("echo CMDMARK_ASK")).isError).toBeFalsy();
    expect(harness.requests).toHaveLength(1);
    const [ask, approved] = listShellDecisions(harness.auditPath);
    expect(ask).toMatchObject({ effect: "ask", origin: "rule" });
    expect(approved).toMatchObject({ effect: "allow", origin: "approval", grant: "once" });
    expect(hashOf(approved)).toBe(hashOf(ask));
    expect(auditText(harness.auditPath)).not.toContain("CMDMARK_ASK");
    expect(auditText(harness.auditPath)).not.toContain("STDOUTMARK_ASK");
  });

  test("a deny and an external_directory keep their own origin and stable reason", async () => {
    mock = installNoDockerSpawnMock();
    const denied = await shellHarness(await isolatedRunCommand("audit-deny"), {
      rules: [{ match: "git push *", effect: "deny" }],
    });
    expect((await denied.run("git push CMDMARK_DENY")).code).toBe("shell_rule_denied");
    const ruleDeny = listShellDecisions(denied.auditPath)[0];
    expect(ruleDeny).toMatchObject({ effect: "deny", origin: "rule", reason: "shell_rule_denied" });
    expect(hashOf(ruleDeny)).toMatch(/^[a-f0-9]{16}$/);
    expect(auditText(denied.auditPath)).not.toContain("CMDMARK_DENY");

    const external = await shellHarness(await isolatedRunCommand("audit-external"), {
      rules: [{ match: "*", effect: "allow" }],
      externalDirectory: "deny",
    });
    expect((await external.run("cat ../CMDMARK_EXTERNAL.txt")).code).toBe("external_directory");
    expect(listShellDecisions(external.auditPath)[0])
      .toMatchObject({ effect: "deny", origin: "external_directory", reason: "external_directory" });
    expect(auditText(external.auditPath)).not.toContain("CMDMARK_EXTERNAL");
    expect(mock.calls).toHaveLength(0);
  });

  test("an unparsable command is a deny with the scanner origin", async () => {
    mock = installNoDockerSpawnMock();
    const harness = await shellHarness(await isolatedRunCommand("audit-unparsable"), {
      rules: [{ match: "*", effect: "allow" }],
    });
    const result = await harness.run("echo $(CMDMARK_UNPARSABLE)");
    expect(result.code).toBe("shell_unparsable");
    expect(listShellDecisions(harness.auditPath)[0])
      .toMatchObject({ effect: "deny", origin: "unparsable", reason: "shell_unparsable" });
    expect(auditText(harness.auditPath)).not.toContain("CMDMARK_UNPARSABLE");
    expect(mock.calls).toHaveLength(0);
  });

  test("an 'always' that cannot be persisted is audited as degraded", async () => {
    mock = installNoDockerSpawnMock({ stdout: "STDOUTMARK_DEGRADED\n" });
    // No project config path: the prefix rule cannot be written, the call runs once.
    const harness = await shellHarness(await isolatedRunCommand("audit-degraded"), {
      rules: [{ match: "*", effect: "ask" }],
      approve: () => "always",
    });
    expect((await harness.run("echo CMDMARK_DEGRADED")).isError).toBeFalsy();
    const events = listShellDecisions(harness.auditPath);
    // The approval allow is followed by the execution allow, so match by origin.
    const approved = events.find((event) => event.origin === "approval");
    expect(approved).toMatchObject({ effect: "allow", origin: "approval", grant: "once", degraded: true });
    expect(auditText(harness.auditPath)).not.toContain("CMDMARK_DEGRADED");
    expect(auditText(harness.auditPath)).not.toContain("STDOUTMARK_DEGRADED");
  });

  test("bypass stamps the mode when it discards an ask rule", async () => {
    mock = installNoDockerSpawnMock({ stdout: "STDOUTMARK_BYPASS\n" });
    const harness = await shellHarness(await isolatedRunCommand("audit-bypass-origin"), {
      rules: [{ match: "*", effect: "ask" }],
      mode: "bypass",
      env: { ...process.env, [HOST_SHELL_BYPASS_CONFIRMATION_ENV]: "1" },
    });
    expect((await harness.run("echo CMDMARK_BYPASS")).isError).toBeFalsy();
    expect(harness.requests).toHaveLength(0);
    // The rule asked; bypass discarded the ask, so the mode is the origin.
    expect(listShellDecisions(harness.auditPath)[0])
      .toMatchObject({ effect: "allow", origin: "mode", permissionMode: "bypass" });
    expect(auditText(harness.auditPath)).not.toContain("CMDMARK_BYPASS");
    expect(auditText(harness.auditPath)).not.toContain("STDOUTMARK_BYPASS");
  });

  test("run_tests decisions and results carry hashes, never the model filter", async () => {
    mock = installNoDockerSpawnMock({ stdout: "tests ok\n" });
    const mod = await isolatedRunCommand("audit-run-tests");
    mod.configureRunCommand({ mode: "host" });
    const cwd = mkdtempSync(join(tmpdir(), "astro-shell-audit-"));
    const auditPath = join(cwd, ".astro", "audit.jsonl");
    const tool = mod.createRunTestsTool({ config: { command: ["echo", "test"] }, audit: new Auditor(auditPath) });
    const executor = new ToolExecutor({
      tools: [tool], allow: ["run_tests"], audit: new Auditor(auditPath), permissionMode: "ask", approveTool: () => true,
    });
    const result = await executor.run(
      { cwd, run: "r1", agent: "coder", env: { ...process.env } },
      { id: "c1", name: "run_tests", arguments: JSON.stringify({ filter: "CMDMARK_FILTER.test.ts" }) },
    );
    expect(result.isError).toBeFalsy();
    const [ask, approved] = listShellDecisions(auditPath);
    expect(ask).toMatchObject({ tool: "run_tests", effect: "ask", origin: "mode", transport: "host" });
    expect(approved).toMatchObject({ effect: "allow", origin: "approval", grant: "once" });
    expect(hashOf(ask)).toMatch(/^[a-f0-9]{16}$/);
    expect(hashOf(approved)).toBe(hashOf(ask));
    // The result keeps the correlation hash and drops the argv, which carries the filter.
    const resultEvent = readFileSync(auditPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> })
      .find((event) => event.tipo === "tests.result");
    expect(resultEvent?.payload).toMatchObject({ commandHash: hashOf(ask) });
    expect(resultEvent?.payload.command).toBeUndefined();
    expect(auditText(auditPath)).not.toContain("CMDMARK_FILTER");
  });

  test("a run_tests filter refused at execution is audited as a deny, with tool and transport", async () => {
    mock = installNoDockerSpawnMock();
    const mod = await isolatedRunCommand("audit-run-tests-filter");
    mod.configureRunCommand({ mode: "host" });
    const cwd = mkdtempSync(join(tmpdir(), "astro-shell-audit-"));
    const auditPath = join(cwd, ".astro", "audit.jsonl");
    const tool = mod.createRunTestsTool({ config: { command: ["echo", "test"] }, audit: new Auditor(auditPath) });
    const executor = new ToolExecutor({
      tools: [tool], allow: ["run_tests"], audit: new Auditor(auditPath), permissionMode: "ask", approveTool: () => true,
    });
    const run = (filter: string) => executor.run(
      { cwd, run: "r1", agent: "coder", env: { ...process.env } },
      { id: "c1", name: "run_tests", arguments: JSON.stringify({ filter }) },
    );

    const escaped = await run("../CMDMARK_ESCAPE.test.ts");
    expect(escaped.code).toBe("external_directory");
    expect(listShellDecisions(auditPath).at(-1)).toMatchObject({
      tool: "run_tests", stage: "execution", transport: "host",
      effect: "deny", origin: "external_directory", reason: "external_directory",
    });

    writeFileSync(join(cwd, ".env"), "SECRET=1\n");
    const blocked = await run(".env*");
    expect(blocked.code).toBe("path_hard_blocked");
    expect(listShellDecisions(auditPath).at(-1)).toMatchObject({
      tool: "run_tests", stage: "execution", effect: "deny", origin: "mode", reason: "path_hard_blocked",
    });
    expect(auditText(auditPath)).not.toContain("CMDMARK_ESCAPE");
    expect(mock.calls).toHaveLength(0);
  });
});
