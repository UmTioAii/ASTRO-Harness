import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { installNoDockerSpawnMock, isolatedRunCommand, type DockerMock } from "./helpers/docker-mock";
import { listShellDecisions, shellHarness } from "./helpers/shell-audit";

let mock: DockerMock | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });

const hashOf = (payload: Record<string, unknown> | undefined): string => String(payload?.commandHash);

describe("host_shell.decision audit (#599, D-11, I-03)", () => {
  test("a rule allow is audited with commandHash, effect and origin, never the command", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const harness = await shellHarness(await isolatedRunCommand("audit-rule-allow"), {
      rules: [{ match: "echo *", effect: "allow" }],
    });
    const result = await harness.run("echo audit-marker");
    expect(result.isError).toBeFalsy();
    const [event] = listShellDecisions(harness.auditPath);
    expect(event).toMatchObject({ tool: "run_command", stage: "gate", effect: "allow", origin: "rule" });
    expect(hashOf(event)).toMatch(/^[a-f0-9]{16}$/);
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain("audit-marker");
    expect(readFileSync(harness.auditPath, "utf8")).not.toContain("ok\n");
  });

  test("an ask is audited before the answer and the approval carries grant and origin", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    const harness = await shellHarness(await isolatedRunCommand("audit-ask"), {
      rules: [{ match: "*", effect: "ask" }],
      approve: () => "once",
    });
    expect((await harness.run("echo ask-marker")).isError).toBeFalsy();
    expect(harness.requests).toHaveLength(1);
    const [ask, approved] = listShellDecisions(harness.auditPath);
    expect(ask).toMatchObject({ effect: "ask", origin: "rule" });
    expect(approved).toMatchObject({ effect: "allow", origin: "approval", grant: "once" });
    expect(hashOf(approved)).toBe(hashOf(ask));
  });

  test("a deny and an external_directory keep their own origin and stable reason", async () => {
    mock = installNoDockerSpawnMock();
    const denied = await shellHarness(await isolatedRunCommand("audit-deny"), {
      rules: [{ match: "git push *", effect: "deny" }],
    });
    expect((await denied.run("git push origin main")).code).toBe("shell_rule_denied");
    expect(listShellDecisions(denied.auditPath)[0])
      .toMatchObject({ effect: "deny", origin: "rule", reason: "shell_rule_denied" });

    const external = await shellHarness(await isolatedRunCommand("audit-external"), {
      rules: [{ match: "*", effect: "allow" }],
      externalDirectory: "deny",
    });
    expect((await external.run("cat ../outside.txt")).code).toBe("external_directory");
    expect(listShellDecisions(external.auditPath)[0])
      .toMatchObject({ effect: "deny", origin: "external_directory", reason: "external_directory" });
    expect(mock.calls).toHaveLength(0);
  });

  test("an unparsable command is a deny with the scanner origin", async () => {
    mock = installNoDockerSpawnMock();
    const harness = await shellHarness(await isolatedRunCommand("audit-unparsable"), {
      rules: [{ match: "*", effect: "allow" }],
    });
    const result = await harness.run("echo $(pwd)");
    expect(result.code).toBe("shell_unparsable");
    expect(listShellDecisions(harness.auditPath)[0])
      .toMatchObject({ effect: "deny", origin: "unparsable", reason: "shell_unparsable" });
    expect(mock.calls).toHaveLength(0);
  });

  test("an 'always' that cannot be persisted is audited as degraded", async () => {
    mock = installNoDockerSpawnMock({ stdout: "ok\n" });
    // No project config path: the prefix rule cannot be written, the call runs once.
    const harness = await shellHarness(await isolatedRunCommand("audit-degraded"), {
      rules: [{ match: "*", effect: "ask" }],
      approve: () => "always",
    });
    expect((await harness.run("echo degraded-marker")).isError).toBeFalsy();
    const events = listShellDecisions(harness.auditPath);
    expect(events.at(-1)).toMatchObject({ effect: "allow", origin: "approval", grant: "once", degraded: true });
  });

  test("run_tests decisions are audited with the configured argv hash", async () => {
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
      { id: "c1", name: "run_tests", arguments: "{}" },
    );
    expect(result.isError).toBeFalsy();
    const [ask, approved] = listShellDecisions(auditPath);
    expect(ask).toMatchObject({ tool: "run_tests", effect: "ask", origin: "mode" });
    expect(approved).toMatchObject({ effect: "allow", origin: "approval", grant: "once" });
    expect(hashOf(ask)).toMatch(/^[a-f0-9]{16}$/);
    expect(hashOf(approved)).toBe(hashOf(ask));
  });
});
