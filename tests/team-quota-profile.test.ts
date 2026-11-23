/** #617: per-agent token quotas are enforced only in the Control profile. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/core/app";
import { Ledger } from "../src/ledger";
import { testEnv } from "./setup";

function setup(preset: "default" | "control") {
  const dir = mkdtempSync(join(tmpdir(), "astro-team-quota-"));
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      calls++;
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    },
  });
  mkdirSync(join(dir, ".astro"), { recursive: true });
  new Ledger(join(dir, ".astro", "ledger.jsonl"), { warn: () => {} }).record({
    run: "seed", agent: "default", provider: "p", model: "m",
    credentialRef: "KEY", quotaDomain: "p", tokensIn: 100, tokensOut: 0,
  });
  const configPath = join(dir, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    version: "2.0.0",
    preset,
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 4096 }],
    agent: { model: "p/m", tools: [] },
    team: { agentQuotas: { default: { dailyTokens: 1 } } },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { dir, configPath, calls: () => calls, stop: () => server.stop(true) };
}

test("#617 default profile ignores team.agentQuotas", async () => {
  const { dir, configPath, calls, stop } = setup("default");
  try {
    const report = await runTask({ configPath, task: "x", cwd: dir, env: testEnv({ KEY: "k" }) });
    expect(report.final).toBe("ok");
    expect(calls()).toBeGreaterThan(0);
  } finally {
    stop();
  }
});

test("#617 control profile still enforces team.agentQuotas", async () => {
  const { dir, configPath, calls, stop } = setup("control");
  try {
    const error = await runTask({ configPath, task: "x", cwd: dir, env: testEnv({ KEY: "k" }) })
      .then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toMatch(/quota|limite/i);
    expect(calls()).toBe(0);
  } finally {
    stop();
  }
});
