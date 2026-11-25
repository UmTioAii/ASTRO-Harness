import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock, activeLocks } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { activeByAccount, grantConcurrency, resolveConcurrencyCap, spawnConcurrencyCap } from "../src/concurrency";
import { validateConfig, type AstroConfig } from "../src/core/config";
import { Ledger } from "../src/ledger";
import { formatLocksList, summarizeLocks } from "../src/locks";
import { resetCandidateSnapshots } from "../src/model-choice";
import { Registry } from "../src/core/registry";
import { createSpawnAgentTool, SpawnRegistry } from "../src/spawn";
import type { ToolContext } from "../src/tools/types";

function config(over: Record<string, unknown> = {}): AstroConfig {
  return validateConfig({
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
    },
    models: [
      { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, efficiency: 0.5,
        capabilities: { tools: true }, price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
      { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, efficiency: 0.4,
        capabilities: { tools: true }, price: { inputPerM: 2, outputPerM: 2, fonte: "t", verificado: false } },
    ],
    agent: { model: "p1/m1", maxSteps: 5, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...over,
  });
}

function setup(cfg: AstroConfig = config()) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-concurrency-"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const registry = new Registry(cfg);
  const spawns = new SpawnRegistry();
  writeFileSync(join(cwd, "AGENTS.md"), "rules");
  const tool = createSpawnAgentTool({ config: cfg, registry, ledger, audit, cwd, spawns, enabled: true });
  const ctx: ToolContext = { cwd, run: "r1", agent: "planner", allow: ["read_file"], maxSteps: 3 };
  return { cwd, cfg, ledger, audit, registry, spawns, tool, ctx };
}

beforeEach(() => resetCandidateSnapshots());

describe("concurrency cap resolution (ADR-0037)", () => {
  test("explicit request > /config > default two per provider", () => {
    expect(resolveConcurrencyCap({})).toEqual({ cap: 2, source: "default" });
    expect(resolveConcurrencyCap({ config: 3 })).toEqual({ cap: 3, source: "config" });
    expect(resolveConcurrencyCap({ config: 3, request: 5 })).toEqual({ cap: 5, source: "request" });
    // Invalid declarations never widen the bound.
    expect(resolveConcurrencyCap({ config: 0, request: -1 })).toEqual({ cap: 2, source: "default" });
  });

  test("a request above the cap is truncated with a reason the caller can report", () => {
    const capped = resolveConcurrencyCap({ config: 2 });
    expect(grantConcurrency(8, capped)).toEqual({
      requested: 8,
      granted: 2,
      cap: 2,
      source: "config",
      truncated: true,
      reason: "requested 8, granted 2: config cap",
    });
    expect(grantConcurrency(1, capped)).toMatchObject({ requested: 1, granted: 1, truncated: false });
  });
});

describe("bounded spawn (ADR-0037)", () => {
  test("agent.spawn carries requested, granted, cap, source and reason", async () => {
    const { cfg, ledger, audit, tool, ctx } = setup(config({ spawn: { maxConcurrent: 3 } }));
    expect(cfg.spawn?.maxConcurrent).toBe(3);

    const result = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(result.isError).toBe(false);
    const spawned = audit.readAll().find((event) => event.tipo === "agent.spawn");
    expect(spawned?.payload).toMatchObject({
      requested: 1,
      granted: 1,
      cap: 3,
      source: "config",
      door: "model",
      reason: "default_rank",
      grant_reason: "within config cap",
    });
    expect(ledger.readAllEntries().some((entry) => entry.kind === "agent" && entry.event === "created")).toBe(true);
  });

  test("a spawn above the cap reports the cut in the tool result", async () => {
    const { tool, ctx } = setup(config({ spawn: { maxConcurrent: 2 } }));
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], concurrency: 8 }, ctx);
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.output) as { concurrency: Record<string, unknown>; note?: string };
    expect(body.concurrency).toEqual({
      requested: 8,
      granted: 2,
      cap: 2,
      source: "config",
      truncated: true,
      reason: "requested 8, granted 2: config cap",
    });
    expect(body.note).toContain("requested 8, granted 2");
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
    expect(note).toContain("requested 8, granted 2");
    expect(note).toContain("maxTurns now means turns");
  });

  test("spawn.maxConcurrent rejects zero, fractional and above-ceiling values", () => {
    expect(() => config({ spawn: { maxConcurrent: 0 } })).toThrow(/maxConcurrent/);
    expect(() => config({ spawn: { maxConcurrent: 2.5 } })).toThrow(/maxConcurrent/);
    expect(() => config({ spawn: { maxConcurrent: 9 } })).toThrow(/maxConcurrent/);
    expect(() => config({ spawn: { maxConcurrent: 64 } })).toThrow(/physical ceiling/);
  });

  test("two agents share one account; the third execution is refused", async () => {
    const single = config({
      providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" } },
      models: [{ provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192,
        capabilities: { tools: true } }],
    });
    const { ledger, audit, tool, ctx } = setup(single);
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "planner", session_id: "r1", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
    });
    const first = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.output).model).toBe("p1/m1");
    expect(activeByAccount(ledger).get("KEY1")).toBe(2);

    const second = await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.output)).toMatchObject({ error: "spawn_limit_exceeded" });
    expect(JSON.parse(second.output).message).toContain("concorrência");
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
    expect(spawnConcurrencyCap({ spawn: { maxConcurrent: 1000 } } as unknown as AstroConfig).cap).toBe(8);
    expect(spawnConcurrencyCap({ spawn: { maxConcurrent: 1000 } } as unknown as AstroConfig).source).toBe("config");
  });

  test("a child cannot spawn a grandchild", async () => {
    const { spawns, tool, ctx } = setup();
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);
    const nested = await tool.execute({ need: "writing-code", task: "b", tools: [] }, { ...ctx, agent: "sub-1" });
    expect(nested.isError).toBe(true);
    expect(JSON.parse(nested.output).error).toBe("invalid_request");
    expect(spawns.size).toBe(1);
  });

  test("two providers sharing one credential use the account as the concurrency unit", async () => {
    const shared = config({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY1" },
      },
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
    });
    const { ledger, audit, spawns, tool, ctx } = setup(shared);
    for (const [run, agent] of [["other-1", "one"], ["other-2", "two"]] as const) {
      acquireAgentLock(ledger, audit, {
        run, agent_id: agent, session_id: run, provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
      });
    }

    const result = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(result.isError).toBe(true);
    // The chooser must not offer p2 at "0 executions" and let the lock fail afterwards.
    expect(JSON.parse(result.output)).toMatchObject({ error: "spawn_limit_exceeded" });
    expect(spawns.size).toBe(0);
    expect(ledger.readAllEntries().some((entry) => entry.kind === "agent" && entry.agent_id === "sub-1")).toBe(false);
  });
});

describe("shared account accounting", () => {
  test("astro locks reports executions and accounts, not exclusive possession", () => {
    const { ledger, audit } = setup();
    for (const agent of ["planner", "sub-1"]) {
      acquireAgentLock(ledger, audit, {
        run: "r1", agent_id: agent, session_id: "r1", provider: "p1",
        credentialRef: "KEY1", accountRef: "KEY1", pid: process.pid,
      });
    }
    const locks = summarizeLocks(ledger, () => true);
    expect(locks).toHaveLength(2);
    const text = formatLocksList(locks);
    expect(text).toContain("2 execuções ativas em 1 conta");
    expect(text).toContain("2 execuções");
  });
});
