import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { validateConfig, type AstroConfig } from "../src/core/config";
import { Ledger } from "../src/ledger";
import { listModelCandidates, resetCandidateSnapshots } from "../src/model-choice";
import { Registry } from "../src/core/registry";
import { createSpawnAgentTool, SpawnRegistry } from "../src/spawn";
import type { ToolContext } from "../src/tools/types";

function config(): AstroConfig {
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
    modelPool: { fast: { model: "p1/m1" }, smart: { model: "p2/m2" } },
    agent: { model: "p1/m1", maxSteps: 5, tools: ["handoff", "read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function setup(limit?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-spawn-"));
  const cfg = config();
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const registry = new Registry(cfg);
  const spawns = new SpawnRegistry(limit === undefined ? {} : { limit });
  writeFileSync(join(cwd, "AGENTS.md"), "Instruções do projeto");
  const tool = createSpawnAgentTool({ config: cfg, registry, ledger, audit, cwd, spawns, enabled: true });
  const ctx: ToolContext = { cwd, run: "r1", agent: "planner", allow: ["handoff", "read_file"], maxSteps: 3 };
  return { cwd, cfg, ledger, audit, registry, spawns, tool, ctx };
}

beforeEach(() => resetCandidateSnapshots());

describe("tool spawn_agent (S-11, A1/A2/A3/A5)", () => {
  test("cria subagente com modelo/profile da pool, escopo ⊆ pai e reason no ledger", async () => {
    const { ledger, spawns, tool, ctx } = setup();
    const result = await tool.execute({ need: "writing-code", task: "sub tarefa", tools: ["read_file"], maxRounds: 2 }, ctx);
    const body = JSON.parse(result.output) as { agent_id: string; model: string; profile?: string; status: string };

    expect(result.isError).toBe(false);
    expect(body).toMatchObject({ agent_id: "sub-1", model: "p1/m1", profile: "fast", status: "active" });
    expect(spawns.get("sub-1")?.tools).toEqual(["read_file"]);
    expect(spawns.get("sub-1")?.instructions).toBe("sub tarefa");

    const created = ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "created");
    const snapshotId = created?.kind === "agent" ? created.snapshot_id : undefined;
    expect(created).toMatchObject({
      agent_id: "sub-1", parent_agent_id: "planner", model: "m1", provider: "p1", profile: "fast",
      reason: "default_rank", need: "writing-code", snapshot_id: expect.any(String),
    });
    expect(snapshotId).toMatch(/^[0-9a-f]{64}$/); // I-06: snapshot correlacionável
  });

  test("maxRounds limits the child and maxTurns means one turn", async () => {
    const { spawns, tool, ctx } = setup();
    const rounds = await tool.execute({ need: "writing-code", task: "a", maxRounds: 2 }, ctx);
    expect(rounds.isError).toBe(false);
    expect(spawns.get("sub-1")?.maxRounds).toBe(2);
    expect(spawns.get("sub-1")?.maxTurns).toBe(1);

    const oneTurn = await tool.execute({ need: "writing-code", task: "b", maxTurns: 1 }, ctx);
    expect(oneTurn.isError).toBe(false);
    expect(spawns.get("sub-2")?.maxTurns).toBe(1);
    expect(spawns.get("sub-2")?.maxRounds).toBe(3); // parent ceiling
    expect(JSON.parse(oneTurn.output).limits).toEqual({ rounds: 3, turns: 1 });
    expect(JSON.parse(oneTurn.output).note).toContain("maxTurns now means turns");

    const twoTurns = await tool.execute({ need: "writing-code", task: "c", maxTurns: 2 }, ctx);
    expect(twoTurns.isError).toBe(true);
    expect(JSON.parse(twoTurns.output).message).toContain("one turn");

    const legacy = await tool.execute({ need: "writing-code", task: "d", maxSteps: 1 }, ctx);
    expect(legacy.isError).toBe(true);
    expect(JSON.parse(legacy.output).message).toContain("maxRounds");

    const invalid = await tool.execute({ need: "writing-code", task: "e", maxRounds: "2" }, ctx);
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.output).message).toContain("'maxRounds'");
  });

  test("o schema anuncia maxRounds e maxTurns e marca maxSteps como removido (#594)", () => {
    const { tool } = setup();
    const properties = (tool.manifest.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(properties.maxRounds?.description).toContain("rodadas");
    expect(properties.maxTurns?.description).toContain("Turnos");
    expect(properties.maxTurns?.description).not.toContain("Obsoleto");
    expect(properties.maxSteps?.description).toContain("Removido");
  });

  test("snapshot velho falha fechado quando o provider enche durante a escolha", async () => {
    const { cfg, ledger, audit, registry, tool, ctx } = setup();
    // Snapshot emitido antes de o provider encher.
    const snap = listModelCandidates({ need: "writing-code" }, { config: cfg, registry, ledger });
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);

    // p1 já tem o pai e o sub-1; outra execução ocupa a segunda vaga.
    acquireAgentLock(ledger, audit, {
      run: "other", agent_id: "holder", session_id: "other", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
    });
    const stale = await tool.execute({ need: "writing-code", task: "d", model: "p1/m1", snapshot_id: snap.snapshot_id }, ctx);
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.output)).toMatchObject({ error: "spawn_limit_exceeded" });
    expect(JSON.parse(stale.output).message).toContain("p1");

    expect((await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx)).isError).toBe(false);
    acquireAgentLock(ledger, audit, {
      run: "other", agent_id: "holder-p2", session_id: "other", provider: "p2", credentialRef: "KEY2", accountRef: "KEY2",
    });
    const third = await tool.execute({ need: "writing-code", task: "c", tools: [] }, ctx);
    expect(third.isError).toBe(true);
    expect(JSON.parse(third.output)).toMatchObject({ error: "spawn_limit_exceeded" });
  });

  test("limite de spawns por run dispara spawn_limit_exceeded", async () => {
    const { tool, ctx } = setup(1);
    expect((await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx)).isError).toBe(false);
    const second = await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx);
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.output)).toMatchObject({ error: "spawn_limit_exceeded" });
  });

  test("tools fora do pai e maxRounds maior que o pai são recusados", async () => {
    const { tool, ctx } = setup();
    const outside = await tool.execute({ need: "writing-code", task: "a", tools: ["run_command"] }, ctx);
    expect(outside.isError).toBe(true);
    expect(JSON.parse(outside.output)).toMatchObject({ error: "invalid_request" });

    const tooLong = await tool.execute({ need: "writing-code", task: "a", tools: [], maxRounds: 99 }, ctx);
    expect(tooLong.isError).toBe(true);
    expect(JSON.parse(tooLong.output)).toMatchObject({ error: "invalid_request" });
    expect(JSON.parse(tooLong.output).message).toContain("maxRounds 99");
  });

  test("modelo fora do snapshot devolve invalid_model_choice com a lista", async () => {
    const { cfg, ledger, registry, tool, ctx } = setup();
    const snapshot = listModelCandidates({ need: "writing-code", requires: ["tools"] }, { config: cfg, registry, ledger });
    const result = await tool.execute({ need: "writing-code", task: "a", model: "p1/ghost", snapshot_id: snapshot.snapshot_id }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.output) as { error: string; candidates: unknown[] };
    expect(body.error).toBe("invalid_model_choice");
    expect(body.candidates.length).toBeGreaterThan(0);
  });

  test("subagente não spawna neto em v1 e snapshot com need divergente falha", async () => {
    const { cfg, ledger, registry, spawns, tool, ctx } = setup();
    const first = await tool.execute({ need: "writing-code", task: "a", tools: ["read_file"] }, ctx);
    expect(first.isError).toBe(false);

    const childCtx = { ...ctx, agent: "sub-1", allow: ["read_file", "spawn_agent"] };
    const nested = await tool.execute({ need: "writing-code", task: "b", tools: ["spawn_agent"] }, childCtx);
    expect(nested.isError).toBe(true);
    expect(JSON.parse(nested.output)).toMatchObject({ error: "invalid_request" });
    // Mesmo omitindo tools (default herdado), o filho não spawna.
    const inherited = await tool.execute({ need: "writing-code", task: "c" }, childCtx);
    expect(inherited.isError).toBe(true);
    expect(JSON.parse(inherited.output)).toMatchObject({ error: "invalid_request" });
    expect(spawns.size).toBe(1);

    const snapshot = listModelCandidates({ need: "writing-code", requires: ["tools"] }, { config: cfg, registry, ledger });
    const mismatch = await tool.execute({ need: "analysis", task: "b", model: "p1/m1", snapshot_id: snapshot.snapshot_id }, ctx);
    expect(mismatch.isError).toBe(true);
    expect(JSON.parse(mismatch.output)).toMatchObject({ error: "candidate_set_changed" });
  });

  test("sem candidato porque as contas estão no limite em outro run → no_candidates", async () => {
    const { ledger, audit, tool, ctx } = setup();
    for (const [provider, key] of [["p1", "KEY1"], ["p2", "KEY2"]] as const) {
      for (const suffix of ["1", "2"]) {
        acquireAgentLock(ledger, audit, {
          run: "other", agent_id: `holder-${provider}-${suffix}`, session_id: "other", provider, credentialRef: key, accountRef: key,
        });
      }
    }
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ error: "spawn_limit_exceeded" });
  });

  test("reason do chamador preserva o marcador da escolha", async () => {
    const { ledger, tool, ctx } = setup();
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [], reason: "preciso de código" }, ctx);
    expect(result.isError).toBe(false);
    const created = ledger.readAllEntries().find((e) => e.kind === "agent" && e.event === "created");
    expect((created as { reason?: string }).reason).toMatch(/^default_rank: preciso de código/);
  });

  test("conta no limite por outro agente sai dos candidatos e o spawn falha fechado", async () => {
    const { ledger, audit, tool, ctx } = setup();
    for (const suffix of ["1", "2"]) {
      acquireAgentLock(ledger, audit, {
        run: "other", agent_id: `holder-${suffix}`, session_id: "other", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
      });
    }
    const result = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.output) as { model: string };
    expect(body.model).toBe("p2/m2"); // p1 no limite; escolhe p2
  });

  test("#551: com 1 provider, o pai e um filho compartilham a conta; o segundo filho é recusado com erro claro", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-spawn-1p-"));
    const cfg = validateConfig({
      providers: { p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" } },
      models: [{ provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
      modelPool: { fast: { model: "p1/m1" } },
      agent: { model: "p1/m1", maxSteps: 5, tools: ["handoff", "read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const registry = new Registry(cfg);
    const spawns = new SpawnRegistry();
    // In production the orchestrator holds the provider account (ADR-0037):
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "planner", session_id: "r1", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
    });
    const tool = createSpawnAgentTool({ config: cfg, registry, ledger, audit, cwd, spawns, enabled: true });
    const ctx: ToolContext = { cwd, run: "r1", agent: "planner", allow: ["handoff", "read_file"], maxSteps: 3 };

    const first = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(first.isError).toBe(false); // parent + 1 child = 2 executions on the account
    const second = await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx);
    expect(second.isError).toBe(true);
    const body = JSON.parse(second.output) as { error: string; message: string };
    expect(body.error).toBe("spawn_limit_exceeded");
    expect(body.message).toContain("concorrência");
    expect(spawns.size).toBe(1);
  });

  test("#551: o limite é por provider, não por conta declarada", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-spawn-clamp-"));
    const cfg = validateConfig({
      providers: {
        p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
        p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
      },
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p2", id: "m2", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      modelPool: { fast: { model: "p1/m1" }, smart: { model: "p2/m2" } },
      agent: { model: "p1/m1", maxSteps: 9, tools: ["spawn_agent", "handoff", "read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    });
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const registry = new Registry(cfg);
    const spawns = new SpawnRegistry();
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "planner", session_id: "r1", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
    });
    const tool = createSpawnAgentTool({ config: cfg, registry, ledger, audit, cwd, spawns, enabled: true });
    const ctx: ToolContext = { cwd, run: "r1", agent: "planner", allow: ["handoff", "read_file"], maxSteps: 9 };

    const first = await tool.execute({ need: "writing-code", task: "a", tools: [] }, ctx);
    expect(first.isError).toBe(false); // shares p1 with the parent
    expect(JSON.parse(first.output).model).toBe("p1/m1");
    const second = await tool.execute({ need: "writing-code", task: "b", tools: [] }, ctx);
    expect(second.isError).toBe(false); // p1 is at 2, so it uses p2
    expect(JSON.parse(second.output).model).toBe("p2/m2");
    const third = await tool.execute({ need: "writing-code", task: "c", tools: [] }, ctx);
    expect(third.isError).toBe(false); // p2 has one free slot
    const fourth = await tool.execute({ need: "writing-code", task: "d", tools: [] }, ctx);
    expect(fourth.isError).toBe(true);
    expect(JSON.parse(fourth.output)).toMatchObject({ error: "spawn_limit_exceeded" });
    expect(JSON.parse(fourth.output).message).toContain("concorrência");
    expect(spawns.size).toBe(3);
  });
});
