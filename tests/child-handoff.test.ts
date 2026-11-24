import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/core/app";
import { Ledger } from "../src/ledger";
import {
  CHILD_BRIEF_MAX_TOKENS, boundChildBrief, buildChildHandoffArtifact, parseChildResumeLevel,
  planChildResume, type ChildBrief, type ChildResumeLevel,
} from "../src/handoff/children";
import { validateHandoffArtifact } from "../src/handoff/types";
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
  test("a huge brief is clipped to 512 and names every clipped field", () => {
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
    expect(bounded.compaction.droppedFields).toEqual(
      expect.arrayContaining(["objective", "child_output_format", "constraints", "decisions", "next_steps"]),
    );
    expect(bounded.brief.objective.length).toBeLessThanOrEqual(200);
    expect(bounded.brief.whatWasTried.length).toBeLessThanOrEqual(4);
  });

  test("the 512-token level is measured on the serialized brief", () => {
    for (const objective of ["x\n".repeat(100).slice(0, 200), "\u0001".repeat(200), "\uD800".repeat(200)]) {
      const bounded = boundChildBrief(brief({
        objective, outputFormat: "f".repeat(160),
        constraints: Array.from({ length: 4 }, () => "c\n".repeat(60).slice(0, 120)),
        whatWasTried: Array.from({ length: 4 }, () => "w\u0001".repeat(60).slice(0, 120)),
        boundaries: Array.from({ length: 4 }, () => "b\uD800".repeat(60).slice(0, 120)),
      }));
      expect(bounded.returnedTokens).toBeLessThanOrEqual(CHILD_BRIEF_MAX_TOKENS);
      expect(bounded.truncated).toBe(true);
    }
  });

  test("the artifact keeps the five brief fields and validates the output-format bound", () => {
    const a = artifact();
    expect(a.child_output_format).toBe("final text summary");
    expect(a.task).toBe("implement the login screen");
    expect(a.decisions).toEqual(["read auth.ts", "ran tests"]);
    expect(a.constraints).toEqual(["no new dependency"]);
    expect(a.next_steps).toEqual(["no parent transcript", "no grandchild"]);
    expect(() => validateHandoffArtifact({ ...a, child_output_format: "x".repeat(161) })).toThrow();
  });

  test("child_output_format is redacted before the ledger (I-03)", () => {
    const NV = ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890";
    const a = artifact({ brief: brief({ outputFormat: `return ${NV}` }) });
    const path = join(mkdtempSync(join(tmpdir(), "astro-child-secret-")), "ledger.jsonl");
    new Ledger(path).recordHandoff("handoff.created", a.run, a, { agent: a.from });
    expect(readFileSync(path, "utf8")).not.toContain(NV);
  });
});

describe("child resume levels (ADR-0036)", () => {
  const a = artifact();
  test("L1 only on explicit request; L2 is the live default; missing session falls back to L3", () => {
    expect(planChildResume({ requested: "L1", sessionAvailable: true, artifact: a }))
      .toMatchObject({ level: "L1", source: "request", restored: ["brief"] });
    expect(planChildResume({ sessionAvailable: true, artifact: a }))
      .toMatchObject({ level: "L2", source: "default", restored: ["brief", "child_session"], childSession: a.run });
    expect(planChildResume({ requested: "L2", sessionAvailable: false, artifact: a }))
      .toMatchObject({ level: "L3", source: "fallback", restored: ["brief", "journal"] });
    expect(planChildResume({ requested: "L3", sessionAvailable: true, artifact: a }))
      .toMatchObject({ level: "L3", source: "request", restored: ["brief", "journal"] });
  });

  test("L2 always names the session it reopens or reports it missing", () => {
    expect(planChildResume({ sessionAvailable: true, sessionId: "r1.task.live" }))
      .toMatchObject({ level: "L2", restored: ["child_session"], childSession: "r1.task.live" });
    expect(planChildResume({ sessionAvailable: true }))
      .toMatchObject({ level: "L2", restored: [], unavailable: "session_missing" });
    expect(planChildResume({ sessionAvailable: true, sessionId: " " }))
      .toMatchObject({ level: "L2", restored: [], unavailable: "session_missing" });
  });

  test("an unknown level is rejected instead of widening to L3", () => {
    for (const value of ["l1", "L4", "L1 ", " L2"]) {
      expect(() => parseChildResumeLevel(value)).toThrow(/L1, L2 or L3/);
      expect(() => planChildResume({ requested: value as ChildResumeLevel, sessionAvailable: true, artifact: a }))
        .toThrow(/L1, L2 or L3/);
    }
    expect(parseChildResumeLevel(undefined)).toBeUndefined();
    expect(parseChildResumeLevel("L2")).toBe("L2");
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
function harness(handlers: { plan: (call: number) => Response; child: (call: number) => Response },
  opts: { checkpointAt?: number } = {}): Harness {
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
    agent: { model: "p/m1", maxSteps: 5, tools: ["task", "read_file"], entryAgent: "plan" },
    agents: {
      plan: { model: "p/m1", maxSteps: 3, tools: ["task", "read_file"], permission: "full", systemPrompt: "plan-agent" },
      build: { model: "p/m1", maxSteps: 2, tools: [], permission: "write", systemPrompt: "child-agent" },
    },
    ...(opts.checkpointAt === undefined ? {} : { run: { checkpointAt: opts.checkpointAt } }),
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

  test("a configured loop checkpoint may persist the child summary, not a transcript", async () => {
    const sentinel = "CHILD-CHECKPOINT-TEXT";
    const h = harness({
      plan: (call) => call === 1 ? toolCall("task", { agent: "build", prompt: "keep a checkpoint" }) : final("parent-final"),
      child: () => final(sentinel),
    }, { checkpointAt: 0.1 });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: "checkpoint",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("parent-final");
      const sessions = join(h.cwd, ".astro", "sessions");
      const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }) as string[] : [];
      const checkpoint = files.filter((file) => file.endsWith("checkpoint.json"))
        .map((file) => readFileSync(join(sessions, file), "utf8")).join("\n");
      expect(checkpoint).toContain(sentinel);
      expect(new Ledger(join(h.cwd, ".astro", "ledger.jsonl")).readHandoffs()).toHaveLength(0);
    } finally { h.server.stop(true); }
  });

  test("an exceptional handoff writes one bounded artifact without either prompt", async () => {
    const marker = "PARENT-TRANSCRIPT-MARKER";
    const h = harness({
      plan: (call) => call === 1 ? toolCall("read_file", { path: "missing.txt" })
        : call === 2 ? toolCall("task", { agent: "build", prompt: `CHILD-OBJECTIVE ${"x".repeat(4000)}` })
          : final("handled"),
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
      expect(a).toMatchObject({ from: "plan", to: "build", source_step: 2, child_output_format: "final text summary", version: 1 });
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
