import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/core/app";
import { Ledger } from "../src/ledger";
import {
  CHILD_BRIEF_MAX_TOKENS, boundChildBrief, buildChildHandoffArtifact, planChildResume, type ChildBrief,
} from "../src/handoff/children";
import { sanitizeHandoffArtifact } from "../src/handoff/types";
import { testEnv } from "./setup";

const final = (content: string): Response =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const toolCall = (name: string, args: unknown): Response => Response.json({
  choices: [{ message: { content: "", tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const brief = (over: Partial<ChildBrief> = {}): ChildBrief => ({
  objective: "implement the login screen", outputFormat: "final text summary",
  constraints: ["no new dependency"], whatWasTried: ["read auth.ts", "ran tests"],
  boundaries: ["no parent transcript", "no grandchild"], ...over,
});
const artifact = (over: Partial<Parameters<typeof buildChildHandoffArtifact>[0]> = {}) =>
  buildChildHandoffArtifact({ run: "r1.task.abc", from: "planner", to: "coder", sourceStep: 1,
    budgetSpent: { tokens: 10, usd: 0 }, brief: brief(), ...over });

describe("bounded child handoff (ADR-0036)", () => {
  test("a huge brief is clipped to the 512-token level and audited", () => {
    const bounded = boundChildBrief(brief({
      objective: "o".repeat(4000), outputFormat: "f".repeat(4000),
      constraints: Array.from({ length: 20 }, () => "c".repeat(400)),
      whatWasTried: Array.from({ length: 20 }, () => "w".repeat(400)),
      boundaries: Array.from({ length: 20 }, () => "b".repeat(400)),
    }));
    expect(bounded.returnedTokens).toBeLessThanOrEqual(CHILD_BRIEF_MAX_TOKENS);
    expect(bounded.originalTokens).toBeGreaterThan(bounded.returnedTokens);
    expect(bounded.truncated).toBe(true);
    expect(bounded.compaction.strategy).toBe("truncate");
    expect(bounded.brief.objective.length).toBeLessThanOrEqual(200);
    expect(bounded.brief.whatWasTried.length).toBeLessThanOrEqual(4);
  });

  test("the artifact carries the five brief fields and no parent transcript", () => {
    const a = artifact();
    expect(a.child_output_format).toBe("final text summary");
    expect(a.task).toBe("implement the login screen");
    expect(a.decisions).toEqual(["read auth.ts", "ran tests"]);
    expect(a.constraints).toEqual(["no new dependency"]);
    expect(a.next_steps).toEqual(["no parent transcript", "no grandchild"]);
    expect(JSON.stringify(a)).not.toContain("PARENT-ONLY");
  });

  test("the new child_output_format is sanitized before the ledger (I-03)", () => {
    const NV = ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890";
    const a = artifact({ brief: brief({ outputFormat: `return ${NV}` }) });
    expect(JSON.stringify(sanitizeHandoffArtifact(a))).not.toContain(NV);
  });
});

describe("child resume levels (ADR-0036)", () => {
  const a = artifact();
  test("L1 only on an explicit parent request and restores the brief alone", () => {
    expect(planChildResume({ requested: "L1", sessionAvailable: true, artifact: a }))
      .toMatchObject({ level: "L1", source: "request", restored: ["brief"] });
    expect(planChildResume({ sessionAvailable: true, artifact: a }).level).toBe("L2");
    expect(planChildResume({ sessionAvailable: false, artifact: a }).level).toBe("L3");
  });
  test("L2 is the live-session default; a missing session falls back to L3", () => {
    expect(planChildResume({ sessionAvailable: true, artifact: a }))
      .toMatchObject({ level: "L2", source: "default", restored: ["brief", "child_session"], childSession: a.run });
    expect(planChildResume({ requested: "L2", sessionAvailable: false, artifact: a }))
      .toMatchObject({ level: "L3", source: "fallback", restored: ["brief", "journal"] });
    expect(planChildResume({ requested: "L3", sessionAvailable: true, artifact: a }))
      .toMatchObject({ level: "L3", source: "request", restored: ["brief", "journal"] });
  });
  test("L3 needs an artifact and no level restores more context than it allows", () => {
    expect(planChildResume({ sessionAvailable: false }))
      .toMatchObject({ level: "L3", restored: [], unavailable: "artifact_missing" });
    const l1 = planChildResume({ requested: "L1", sessionAvailable: true, artifact: a });
    expect(l1.restored).toEqual(["brief"]);
    expect(l1.restored).not.toContain("child_session");
    expect(l1.restored).not.toContain("journal");
    expect(planChildResume({ sessionAvailable: true, artifact: a }).restored).not.toContain("journal");
    expect(planChildResume({ requested: "L3", sessionAvailable: true, artifact: a }).restored).not.toContain("child_session");
  });
});

interface Harness {
  cwd: string; configPath: string; bodies: Array<{ messages: Array<{ role: string; content: string }> }>;
  calls: { plan: number; child: number }; server: ReturnType<typeof Bun.serve>;
}
function harness(handlers: { plan: (call: number) => Response; child: (call: number) => Response }): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "astro-child-"));
  const calls = { plan: 0, child: 0 };
  const bodies: Harness["bodies"] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = (await req.json()) as Harness["bodies"][number];
    bodies.push(body);
    if (body.messages[0]?.content === "child-agent") return handlers.child(++calls.child);
    return handlers.plan(++calls.plan);
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 5, tools: ["task"], entryAgent: "plan" },
    agents: {
      plan: { model: "p/m1", maxSteps: 3, tools: ["task"], permission: "full", systemPrompt: "plan-agent" },
      build: { model: "p/m1", maxSteps: 2, tools: [], permission: "write", systemPrompt: "child-agent" },
    },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  return { cwd, configPath, bodies, calls, server };
}

describe("task handoff artifact tier", () => {
  test("happy path returns the child summary and writes no artifact or transcript", async () => {
    const h = harness({
      plan: (call) => call === 1 ? toolCall("task", { agent: "build", prompt: "implement" }) : final("parent-final"),
      child: () => final("child-summary"),
    });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: "PARENT-ONLY-TASK",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("parent-final");
      expect(h.bodies.some((body) => JSON.stringify(body.messages).includes("child-summary"))).toBe(true);
      expect(new Ledger(join(h.cwd, ".astro", "ledger.jsonl")).readHandoffs()).toHaveLength(0);
      expect(existsSync(join(h.cwd, ".astro", "sessions"))).toBe(false);
    } finally { h.server.stop(true); }
  });

  test("an exceptional handoff writes one bounded artifact without either prompt", async () => {
    const marker = "PARENT-TRANSCRIPT-MARKER";
    const h = harness({
      plan: (call) => call === 1
        ? toolCall("task", { agent: "build", prompt: `CHILD-OBJECTIVE ${"x".repeat(4000)}` }) : final("handled"),
      child: (call) => call === 1 ? toolCall("read_file", { path: "x" }) : new Response("boom", { status: 400 }),
    });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: marker,
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("handled");
      const ledger = new Ledger(join(h.cwd, ".astro", "ledger.jsonl"));
      const created = ledger.readHandoffs().filter((entry) => entry.kind === "handoff.created");
      expect(created).toHaveLength(1);
      const a = created[0]!.artifact;
      expect(a).toMatchObject({ from: "plan", to: "build", source_step: 1, child_output_format: "final text summary", version: 1 });
      expect(a.objective).toMatch(/^child build · task #[a-f0-9]{16}$/);
      expect(a.truncated).toBeUndefined();
      expect(a.compaction).toEqual({ strategy: "none", droppedFields: [] });
      expect(a.source_refs?.ledger_id).toBe(ledger.id());
      const disk = readFileSync(join(h.cwd, ".astro", "ledger.jsonl"), "utf8");
      expect(disk).not.toContain(marker);
      expect(disk).not.toContain("CHILD-OBJECTIVE");
      expect(existsSync(join(h.cwd, ".astro", "sessions"))).toBe(false);
    } finally { h.server.stop(true); }
  });
});
