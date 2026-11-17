import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTask } from "../../src/app";
import { installDockerSpawnMock } from "../helpers/docker-mock";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, startMockProvider, writeConfig } from "./helpers";

const CREATED = "export function greet(name: string): string {\n  return \"oi \" + name;\n}\n";
const EDITED = "export function greet(name: string): string {\n  return \"olá \" + name;\n}\n";

test("full-flow: create → edit → run → commit ponta a ponta", async () => {
  const provider = startMockProvider([
    { toolCalls: [{ name: "write_file", arguments: { path: "src/greet.ts", content: CREATED } }] },
    {
      toolCalls: [{
        name: "edit",
        arguments: {
          path: "src/greet.ts",
          diff: "@@ -1,3 +1,3 @@\n export function greet(name: string): string {\n-  return \"oi \" + name;\n+  return \"olá \" + name;\n }\n",
        },
      }],
    },
    { toolCalls: [{ name: "run_command", arguments: { command: "bun test" } }] },
    { toolCalls: [{ name: "run_command", arguments: { command: "git add -A && git commit -m flow" } }] },
    { content: "create-edit-run-commit ok" },
  ]);
  // Nada roda no host: docker é mockado, inclusive o commit (sem rede/repo real).
  const docker = installDockerSpawnMock((argv) => argv.join(" ").includes("git commit") ? "committed" : "tests passed");
  const dir = newWorkspace("flow");
  try {
    const configPath = writeConfig(dir, {
      providers: { mock: { kind: "openai-compat", baseUrl: provider.baseUrl, credentialRef: "TEST_KEY" } },
      models: [{ provider: "mock", id: "mock-1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      agent: { model: "mock/mock-1", maxSteps: 8, tools: ["write_file", "edit", "run_command", "read_file"] },
      tools: { run_command: { sandbox: true } },
      permissions: { mode: "allow-edits" },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "crie greet.ts, ajuste a saudação, rode os testes e faça commit",
      cwd: dir,
      env: testEnv({ TEST_KEY: "test-key" }),
      approveTool: () => true,
    });

    expect(report.final).toBe("create-edit-run-commit ok");
    expect(readFileSync(join(dir, "src", "greet.ts"), "utf8")).toBe(EDITED);
    expect(report.tokensIn).toBe(50);
    expect(report.tokensOut).toBe(25);

    const audit = readAudit(dir);
    const toolCalls = audit.events.filter((event) => event.tipo === "tool.call").map((event) => event.payload.name);
    expect(toolCalls).toEqual(["write_file", "edit", "run_command", "run_command"]);
    expect(audit.text).toContain("run.completed");
    expect(audit.text).not.toContain("test-key");

    const commands = docker.runCalls.map((argv) => argv.join(" "));
    expect(commands.some((command) => command.includes("bun test"))).toBe(true);
    expect(commands.some((command) => command.includes("git commit"))).toBe(true);
    // Docker mock nunca deixa o shell cair no host.
    expect(docker.calls.filter((argv) => argv[0] !== "docker")).toHaveLength(0);
  } finally {
    docker.restore();
    provider.server.stop(true);
  }
}, 30000);
