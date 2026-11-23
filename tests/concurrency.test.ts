import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { grantConcurrency, resolveConcurrencyCap, spawnConcurrencyCap } from "../src/concurrency";
import { validateConfig, type AstroConfig } from "../src/core/config";
import { Ledger } from "../src/ledger";
import { resetCandidateSnapshots } from "../src/model-choice";
import { Registry } from "../src/core/registry";
import { createSpawnAgentTool, SpawnRegistry } from "../src/spawn";
import type { ToolContext } from "../src/tools/types";

function config(over: Record<string, unknown> = {}): AstroConfig {
  return validateConfig({
    providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" } },
    models: [{ provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
    agent: { model: "p1/m1", maxSteps: 5, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...over,
  });
}

function setup(cfg: AstroConfig = config()) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-concurrency-"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const spawns = new SpawnRegistry();
  writeFileSync(join(cwd, "AGENTS.md"), "rules");
  const tool = createSpawnAgentTool({
    config: cfg, registry: new Registry(cfg), ledger, audit, cwd, spawns, enabled: true,
  });
  const ctx: ToolContext = { cwd, run: "r1", agent: "planner", allow: ["read_file"], maxSteps: 3 };
  return { ledger, audit, spawns, tool, ctx };
}

beforeEach(() => resetCandidateSnapshots());

describe("concurrency cap resolution (ADR-0037)", () => {
  test("explicit request > /config > default two", () => {
    expect(resolveConcurrencyCap({})).toEqual({ cap: 2, source: "default" });
    expect(resolveConcurrencyCap({ config: 3 })).toEqual({ cap: 3, source: "config" });
    expect(resolveConcurrencyCap({ config: 3, request: 5 })).toEqual({ cap: 5, source: "request" });
    expect(resolveConcurrencyCap({ config: 0, request: -1 })).toEqual({ cap: 2, source: "default" });
  });

  test("a request above the cap is truncated with a reason", () => {
    const capped = resolveConcurrencyCap({ config: 2 });
    expect(grantConcurrency(8, capped)).toMatchObject({
      requested: 8, granted: 2, cap: 2, source: "config", truncated: true, reason: "requested 8, granted 2: config cap",
    });
    expect(grantConcurrency(1, capped)).toMatchObject({ granted: 1, truncated: false });
  });
});

describe("bounded spawn (ADR-0037)", () => {
  test("agent.spawn carries requested/granted/cap/source and both reasons", async () => {
    const { audit, tool, ctx } = setup(config({ spawn: { maxConcurrent: 3 } }));
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);
    const spawned = audit.readAll().find((event) => event.tipo === "agent.spawn");
    expect(spawned?.payload).toMatchObject({
      requested: 1, granted: 1, cap: 1, source: "config",
      reason: "default_rank", grant_reason: "within config cap",
    });
  });

  test("a spawn above the cap states the cut in the tool result", async () => {
    const { tool, ctx } = setup(config({ spawn: { maxConcurrent: 2 } }));
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 8 }, ctx);
    const body = JSON.parse(result.output) as { concurrency: Record<string, unknown>; note?: string };
    expect(body.concurrency).toMatchObject({ requested: 8, granted: 1, cap: 1, truncated: true });
    expect(body.note).toContain("requested 8, granted 1");
  });

  test("granted never exceeds the executable ceiling of the slice", async () => {
    const { tool, ctx } = setup(config({ agents: { maxActive: 3 } }));
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 3 }, ctx);
    const body = JSON.parse(result.output) as { concurrency: { granted: number; cap: number; truncated: boolean } };
    expect(body.concurrency).toMatchObject({ granted: 1, cap: 1, truncated: true });
  });

  test("spawn.maxConcurrent 1 and agents.maxActive precedence reach the tool", async () => {
    const one = setup(config({ spawn: { maxConcurrent: 1 } }));
    const first = await one.tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 2 }, one.ctx);
    expect(JSON.parse(first.output).concurrency).toMatchObject({ granted: 1, cap: 1, source: "config" });

    const explicit = setup(config({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
      },
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      agents: { maxActive: 2 },
      spawn: { maxConcurrent: 3 },
    }));
    const second = await explicit.tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 3 }, explicit.ctx);
    expect(JSON.parse(second.output).concurrency).toMatchObject({ granted: 2, cap: 2, source: "request" });
  });

  test("concurrency 0 is rejected in English", async () => {
    const { tool, ctx } = setup();
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 0 }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).message).toContain("must be an integer >= 1");
  });

  test("the cut note keeps the maxTurns migration hint", async () => {
    const { tool, ctx } = setup(config({ spawn: { maxConcurrent: 2 } }));
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 8, maxTurns: 1 }, ctx);
    const note = JSON.parse(result.output).note as string;
    expect(note).toContain("requested 8, granted 1");
    expect(note).toContain("maxTurns now means turns");
  });

  test("spawn.maxConcurrent rejects zero and fractional values", () => {
    expect(() => config({ spawn: { maxConcurrent: 0 } })).toThrow(/maxConcurrent/);
    expect(() => config({ spawn: { maxConcurrent: 2.5 } })).toThrow(/maxConcurrent/);
  });

  test("agents.maxActive is the explicit tier and wins over spawn.maxConcurrent", async () => {
    const cfg = config({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
        p3: { kind: "openai-compat", baseUrl: "http://p3/v1", credentialRef: "KEY3" },
        p4: { kind: "openai-compat", baseUrl: "http://p4/v1", credentialRef: "KEY4" },
      },
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p3", id: "m3", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p4", id: "m4", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      agents: { maxActive: 4 },
      spawn: { maxConcurrent: 2 },
    });
    expect(cfg.maxActive).toBe(4);
    const { tool, ctx } = setup(cfg);
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 4 }, ctx);
    expect(JSON.parse(result.output).concurrency).toMatchObject({ granted: 4, cap: 4, source: "request" });
  });

  test("concurrency rejects negative and fractional values", async () => {
    const { tool, ctx } = setup();
    for (const concurrency of [-1, 2.5]) {
      const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency }, ctx);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.output).message).toContain("must be an integer >= 1");
    }
  });

  test("agents.maxActive above the physical cap is refused", () => {
    expect(() => config({ agents: { maxActive: 1000 } })).toThrow(/maxActive/);
    expect(() => config({ agents: { maxActive: 1000 } })).toThrow(/physical ceiling/);
  });

  test("spawn.maxConcurrent is also clamped to the physical cap", () => {
    const cfg = config({ spawn: { maxConcurrent: 1000 } });
    expect(spawnConcurrencyCap(cfg).cap).toBe(8);
    expect(spawnConcurrencyCap(cfg).source).toBe("config");
  });

  test("a cut by the A4 account ceiling names that ceiling", async () => {
    const { tool, ctx } = setup(config({ spawn: { maxConcurrent: 3 } }));
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 3 }, ctx);
    const body = JSON.parse(result.output) as { concurrency: { reason: string }; note?: string };
    expect(body.concurrency.reason).toContain("account ceiling");
    expect(body.note).toContain("account ceiling");
  });

  test("a child cannot spawn a grandchild", async () => {
    const { spawns, tool, ctx } = setup();
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);
    const nested = await tool.execute({ need: "writing-code", task: "b", tools: [] }, { ...ctx, agent: "sub-1" });
    expect(nested.isError).toBe(true);
    expect(spawns.size).toBe(1);
  });
});
