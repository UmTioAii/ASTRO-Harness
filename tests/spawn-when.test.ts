import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnRefusedError, spawnDeclaredChild, spawnedPermission, SpawnRegistry } from "../src/spawn";
import { matchDeclaredAgent, whenMatches } from "../src/agent-rules";
import { acquireAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { runTask } from "../src/core/app";
import { validateConfig, type AstroConfig } from "../src/core/config";
import { Registry } from "../src/core/registry";
import { runMultiAgentSession, type MultiAgentSessionOptions } from "../src/core/session";
import { Ledger } from "../src/ledger";
import { resetCandidateSnapshots } from "../src/model-choice";
import type { CompletionResponse, Provider } from "../src/providers/types";
import { rebuildAgentTree } from "../src/resume";
import { ToolExecutor } from "../src/tools/executor";
import { handoffTool } from "../src/tools/handoff";
import type { Tool, ToolClass } from "../src/tools/types";
import { testEnv } from "./setup";

function config(over: Record<string, unknown> = {}): AstroConfig {
  return validateConfig({
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
    },
    models: [
      { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, efficiency: 0.5,
        capabilities: { tools: true }, price: { inputPerM: 1, outputPerM: 1, fonte: "t", verificado: false } },
      { provider: "p2", id: "m2", tags: ["review", "tools"], context: 8192, efficiency: 0.4,
        capabilities: { tools: true }, price: { inputPerM: 2, outputPerM: 2, fonte: "t", verificado: false } },
    ],
    agent: { model: "p1/m1", maxSteps: 5, tools: ["handoff", "read_file", "write_file"] },
    ...over,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function setup(cfg: AstroConfig = config()) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-when-"));
  const ledger = new Ledger(join(cwd, "ledger.jsonl"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const registry = new Registry(cfg);
  const spawns = new SpawnRegistry();
  const deps = { config: cfg, registry, ledger, audit, cwd, spawns, enabled: true };
  // The parent holds its slot first, exactly as the orchestrator does (ADR-0037).
  acquireAgentLock(ledger, audit, {
    run: "r1", agent_id: "planner", session_id: "r1", provider: "p1", credentialRef: "KEY1", accountRef: "KEY1",
  });
  const parent = { run: "r1", agent: "planner", allow: ["handoff", "read_file", "spawn_agent", "task"], maxSteps: 3 };
  return { cwd, cfg, ledger, audit, registry, spawns, deps, parent };
}

function candidate(over: { model?: string; tags?: string[] } = {}) {
  return {
    model: over.model ?? "p1/m1",
    tags: over.tags ?? ["writing-code", "tools"],
    efficiency: 0.5,
    estimated_cost_max_usd: null,
  };
}

beforeEach(() => resetCandidateSnapshots());

describe("declarative matcher (#602)", () => {
  test("predicates are ANDed, an empty matcher never fires and the last match wins", () => {
    const active = { provider: "p1", model: "p1/m1", tags: ["writing-code", "tools"] };
    expect(whenMatches({ provider: "p1" }, active)).toBe(true);
    expect(whenMatches({ provider: "p2" }, active)).toBe(false);
    expect(whenMatches({ tags: ["tools"] }, active)).toBe(true);
    expect(whenMatches({ tags: ["tools", "review"] }, active)).toBe(false);
    expect(whenMatches({}, active)).toBe(false);
    // [].every(...) is vacuously true; an empty predicate set must not match.
    expect(whenMatches({ tags: [] }, active)).toBe(false);
    // An empty list is not a predicate, but a sibling predicate still holds.
    expect(whenMatches({ tags: [], provider: "p1" }, active)).toBe(true);

    const cfg = config({
      agents: {
        planner: { model: "p1/m1" },
        broad: { model: "p1/m1", when: { provider: "p1" } },
        narrow: { model: "p1/m1", when: { model: "p1/m1" } },
        never: { model: "p1/m1", when: { provider: "p2" } },
      },
    });
    expect(matchDeclaredAgent(cfg.agents, active)?.name).toBe("narrow");
  });
});

describe("declarative spawn shares the spawn engine (#602)", () => {
  test("creates a child that intersects the parent scope and audits the rule", () => {
    const { audit, spawns, deps, parent, ledger } = setup();
    const result = spawnDeclaredChild(deps, parent, {
      agent: "scout",
      model: candidate(),
      tools: ["read_file", "run_command", "spawn_agent", "task"],
      maxRounds: 2,
      instructions: "scout prompt",
      permission: "read-only",
    });

    expect(result.agentId).toBe("sub-1");
    // Intersected with the parent and stripped of task/spawn_agent: depth one.
    expect(spawns.get("sub-1")?.tools).toEqual(["read_file"]);
    expect(spawns.get("sub-1")?.instructions).toBe("scout prompt");
    expect(spawns.get("sub-1")?.permission).toBe("read-only");
    const spawned = audit.readAll().find((event) => event.tipo === "agent.spawn");
    expect(spawned?.payload).toMatchObject({
      // `source` stays the concurrency tier; `door` names the creation path.
      source: "default", door: "rule", rule: "scout", granted: 1, cap: 2, reason: "rule:scout",
    });
    expect(ledger.readAllEntries().some((entry) => entry.kind === "agent" && entry.agent_id === "sub-1")).toBe(true);
  });

  test("the cap refuses a second declarative child and a child never spawns a grandchild", () => {
    const { audit, spawns, deps, parent } = setup();
    const request = { agent: "scout", model: candidate(), tools: ["read_file"], maxRounds: 2, instructions: "" };
    spawnDeclaredChild(deps, parent, request);
    expect(() => spawnDeclaredChild(deps, parent, request)).toThrow(/concorrência/);
    expect(spawns.size).toBe(1);
    expect(audit.readAll().filter((event) => event.tipo === "agent.spawn")).toHaveLength(1);

    expect(() => spawnDeclaredChild(deps, { ...parent, agent: "sub-1" }, request)).toThrow(SpawnRefusedError);
  });

  test("a declared full permission never widens a restricted parent", () => {
    expect(spawnedPermission({ permission: "full" }, "read-only", "full")).toBe("read-only");
    expect(spawnedPermission({ permission: "full" }, "full", "read-only")).toBe("read-only");
    expect(spawnedPermission({ permission: "read-only" }, "full", "full")).toBe("read-only");
    expect(spawnedPermission({}, "full", "full")).toBe("full");
  });
});

describe("a turn fires the declared rule once (#602)", () => {
  /** Runs one turn with the given rules and returns the tree and spawn events. */
  async function turn(
    rules: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    over: { models?: unknown[]; planner?: Record<string, unknown> } = {},
  ) {
    const cwd = mkdtempSync(join(tmpdir(), "astro-when-run-"));
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const configPath = join(cwd, "astro.config.json");
      const tools = ["spawn_agent", "handoff", "read_file"];
      writeFileSync(configPath, JSON.stringify({
        providers: { p1: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY1" } },
        models: over.models ?? [{ provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } }],
        agent: { model: "p1/m1", maxSteps: 4, tools },
        agents: {
          planner: { model: "p1/m1", maxSteps: 4, tools, ...over.planner },
          ...rules,
        },
        ...extra,
        paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      }));
      const report = await runTask({ configPath, task: "turn", cwd, env: testEnv({ KEY1: "1" }) });
      const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
      const spawns = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll().filter((event) => event.tipo === "agent.spawn");
      return { report, nodes: rebuildAgentTree(ledger, report.runId).nodes.map((node) => node.agent_id), spawns };
    } finally {
      server.stop(true);
    }
  }

  test("the harness creates the last matching agent as a direct child and never twice", async () => {
    const { report, nodes, spawns } = await turn({
      scout: { model: "p1/m1", tools: ["read_file"], when: { tags: ["tools"] } },
      reviewer: { model: "p1/m1", tools: ["read_file"], systemPrompt: "review rules", when: { provider: "p1" } },
    });
    expect(report.final).toBe("done");
    expect(nodes).toEqual(["planner", "sub-1"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.payload).toMatchObject({ source: "default", door: "rule", rule: "reviewer", model: "p1/m1", parent_agent_id: "planner" });
  });

  test("a rule never bypasses the cap and a refused spawn does not fail the turn", async () => {
    const { report, nodes, spawns } = await turn(
      { scout: { model: "p1/m1", tools: ["read_file"], when: { provider: "p1" } } },
      { spawn: { maxConcurrent: 1 } },
    );
    expect(report.final).toBe("done");
    expect(nodes).toEqual(["planner"]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.payload).toMatchObject({ source: "config", door: "rule", rule: "scout", granted: 0, cap: 1, cut: expect.any(String) });
  });

  test("an empty tag list is refused at load, so no turn can spawn on every model", async () => {
    await expect(turn({ scout: { model: "p1/m1", when: { tags: [] } } })).rejects.toThrow(/tags/);
  });

  test("matching reads the routed strong model and its tags, not the base model", async () => {
    // The first generation call routes to `strongModel` (model-routing.ts).
    const routed = {
      models: [
        { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
        { provider: "p1", id: "m2", tags: ["review", "tools"], context: 8192, capabilities: { tools: true } },
      ],
      planner: { modelRouting: { strongModel: "p1/m2" } },
    };
    const fired = (when: Record<string, unknown>) => turn({ scout: { model: "p1/m1", tools: ["read_file"], when } }, {}, routed);

    const strongModel = await fired({ model: "p1/m2" });
    expect(strongModel.nodes).toEqual(["planner", "sub-1"]);
    expect(strongModel.spawns).toHaveLength(1);

    const baseModel = await fired({ model: "p1/m1" });
    expect(baseModel.spawns).toHaveLength(0);

    const strongTag = await fired({ tags: ["review"] });
    expect(strongTag.spawns).toHaveLength(1);

    const baseTag = await fired({ tags: ["writing-code"] });
    expect(baseTag.spawns).toHaveLength(0);
  });
});

describe("a declared child's permission reaches the executor (#602)", () => {
  function fakeTool(name: string, klass: ToolClass, permission: string, onRun?: () => void): Tool {
    return {
      manifest: {
        name, description: name, parameters: {}, risk: "low", permission, class: klass,
        timeoutMs: 1000, retryable: false, idempotent: true, sideEffects: "none",
      },
      execute: async () => {
        onRun?.();
        return { output: `${name}:ok` };
      },
    };
  }
  const resp = (p: Partial<CompletionResponse>): CompletionResponse => ({
    content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...p,
  });

  test("a declared read-only child is denied a write after handoff", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-when-perm-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const ledger = new Ledger(join(cwd, "ledger.jsonl"));
    const cfg = config({
      agents: {
        planner: { model: "p1/m1", maxSteps: 5, tools: ["handoff", "read_file", "write_file"] },
        writer: { model: "p1/m1", maxSteps: 5, tools: ["read_file", "write_file"], permission: "read-only" },
      },
    });
    const registry = new Registry(cfg);
    const spawns = new SpawnRegistry();
    let writes = 0;
    const tools = [
      handoffTool,
      fakeTool("read_file", "read_common", "read"),
      fakeTool("write_file", "edit", "write", () => { writes++; }),
    ];
    let call = 0;
    const provider: Provider = {
      complete: async () => {
        call++;
        if (call === 1) {
          return resp({ toolCalls: [{ id: "h", name: "handoff", arguments: JSON.stringify({
            to: "sub-1", task: "write", objective: "write", decisions: [], constraints: [], next_steps: [],
          }) }] });
        }
        if (call === 2) return resp({ toolCalls: [{ id: "w", name: "write_file", arguments: "{}" }] });
        return resp({ content: "fim" });
      },
    };
    const writer = registry.requireAgent("writer");
    const writerModel = registry.resolveModel(writer);
    const allow = ["handoff", "read_file", "write_file"];
    const deps = { config: cfg, registry, ledger, audit, cwd, spawns, enabled: true };
    const opts: MultiAgentSessionOptions = {
      run: "r1", credentialRef: "KEY1", quotaDomain: "default", cwd, provider, registry,
      baseModel: registry.require("p1/m1"),
      baseExecutor: new ToolExecutor({ tools, allow, audit, permission: "full", permissionMode: "bypass" }),
      ledger, audit, baseMaxSteps: 5, entryAgent: "planner", maxConcurrent: 2, spawns,
      declarativeSpawn: () => {
        spawnDeclaredChild(deps, { run: "r1", agent: "planner", allow, maxSteps: 5 }, {
          agent: "writer",
          model: {
            model: `${writerModel.provider}/${writerModel.id}`,
            tags: writerModel.tags,
            efficiency: writerModel.efficiency ?? 0,
            estimated_cost_max_usd: null,
          },
          tools: writer.tools ?? [],
          maxRounds: 2,
          instructions: "",
          ...(writer.permission === undefined ? {} : { permission: writer.permission }),
        });
      },
    };
    const result = await runMultiAgentSession(opts, "delegue");
    expect(result.final).toBe("fim");
    expect(result.agentsUsed).toEqual(["planner", "sub-1"]);
    expect(writes).toBe(0);
    const denied = audit.readAll().find((event) => event.tipo === "tool.denied");
    expect(denied).toMatchObject({ agent: "sub-1", payload: { name: "write_file", permission: "read-only" } });
  });
});
