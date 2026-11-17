import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeLocks } from "../../src/agent-lock";
import { runTask } from "../../src/app";
import { Ledger } from "../../src/ledger";
import { testEnv } from "../setup";
import { newWorkspace, readAudit, readLedger, startDownProvider, startMockProvider, writeConfig } from "./helpers";

test("provider-fallback: primário em outage e o run continua no provider de reserva", async () => {
  const down = startDownProvider();
  const backup = startMockProvider([
    { toolCalls: [{ name: "write_file", arguments: { path: "out/fallback.txt", content: "fallback served\n" } }] },
    { content: "fallback concluído" },
  ]);
  const dir = newWorkspace("provider-fallback");
  try {
    const configPath = writeConfig(dir, {
      providers: {
        primary: {
          kind: "openai-compat", baseUrl: `http://127.0.0.1:${down.port}/v1`, credentialRef: "KEY_A",
          fallback: ["backup"], maxRetries: 0, retryBackoffMs: 1, priority: 1,
        },
        backup: { kind: "openai-compat", baseUrl: backup.baseUrl, credentialRef: "KEY_B", priority: 2 },
      },
      models: [
        { provider: "primary", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "backup", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      agent: { model: "primary/m1", maxSteps: 6, tools: ["write_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });

    const report = await runTask({
      configPath,
      task: "conclua mesmo com o primário fora",
      cwd: dir,
      env: testEnv({ KEY_A: "key-a-secret", KEY_B: "key-b-secret" }),
      approveTool: () => true,
      approveSwap: () => true,
    });

    expect(report.final).toBe("fallback concluído");
    expect(readFileSync(join(dir, "out", "fallback.txt"), "utf8")).toBe("fallback served\n");

    const usage = readLedger(dir).filter((entry) => entry.kind === undefined || entry.kind === "usage");
    expect(usage.length).toBeGreaterThanOrEqual(2);
    expect(usage.every((entry) => entry.provider === "backup")).toBe(true);

    const audit = readAudit(dir);
    expect(audit.events.some((event) => event.tipo === "provider.failure")).toBe(true);
    expect(audit.events.some((event) => event.tipo === "provider.success")).toBe(true);
    expect(audit.events.some((event) => event.tipo === "agent.lock.moved")).toBe(true);
    expect(audit.text).not.toContain("key-a-secret");
    expect(audit.text).not.toContain("key-b-secret");

    const ledger = new Ledger(join(dir, ".astro", "ledger.jsonl"));
    expect(activeLocks(ledger)).toEqual([]);
  } finally {
    backup.server.stop(true);
    down.stop(true);
  }
}, 30000);
