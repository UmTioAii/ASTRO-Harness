import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/core/app";
import { Auditor } from "../src/audit";
import { Ledger } from "../src/ledger";
import {
  CHILD_BRIEF_MAX_TOKENS, CHILD_SESSION_HANDLES_MAX, ChildResumeError, ChildSessionRegistry, RESUME_INSTRUCTION_MAX_CHARS,
  boundChildBrief, buildChildHandoffArtifact, parseChildResumeLevel, planChildResume,
  resolveChildResume, type ChildBrief, type ChildResumeLevel, type ChildSessionHandle,
} from "../src/handoff/children";
import { validateHandoffArtifact } from "../src/handoff/types";
import { createTaskTool, type TaskResumer } from "../src/tools/task";
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
type Body = Harness["bodies"][number];
function harness(handlers: { plan: (call: number, body: Body) => Response; child: (call: number, body: Body) => Response },
  opts: { checkpointAt?: number; planSteps?: number; rounds?: number } = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "astro-child-"));
  const calls = { plan: 0, child: 0 };
  const bodies: Harness["bodies"] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = (await req.json()) as Harness["bodies"][number];
    bodies.push(body);
    if (body.messages[0]?.content === "child-agent") return handlers.child(++calls.child, body);
    return handlers.plan(++calls.plan, body);
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 5, tools: ["task", "read_file"], entryAgent: "plan" },
    agents: {
      plan: { model: "p/m1", maxSteps: opts.planSteps ?? 3, tools: ["task", "read_file"], permission: "full", systemPrompt: "plan-agent" },
      build: { model: "p/m1", maxSteps: 2, tools: [], permission: "write", systemPrompt: "child-agent" },
    },
    ...(opts.checkpointAt === undefined && opts.rounds === undefined
      ? {}
      : {
          run: {
            ...(opts.checkpointAt === undefined ? {} : { checkpointAt: opts.checkpointAt }),
            ...(opts.rounds === undefined ? {} : { maxRoundsPerTurn: opts.rounds, noProgressSegments: opts.rounds }),
          },
        }),
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

describe("live child resume handle (ADR-0036, #602)", () => {
  const handle = (over: Partial<ChildSessionHandle> = {}): ChildSessionHandle => ({
    session: "r1.task.live", parentRun: "r1", parentAgent: "plan", childAgent: "build", brief: brief(),
    history: [{ role: "assistant", content: "child did half" }],
    run: async () => ({ final: "resumed", steps: 1, messages: [] }), ...over,
  });
  const registryOf = (over: Partial<ChildSessionHandle> = {}): ChildSessionRegistry => {
    const registry = new ChildSessionRegistry();
    registry.register(handle(over));
    return registry;
  };
  const resolve = (registry: ChildSessionRegistry, over: Record<string, unknown> = {}) =>
    resolveChildResume(registry, {
      sessionId: "r1.task.live", instruction: "add the tests",
      caller: { run: "r1", agent: "plan" }, ...over,
    } as Parameters<typeof resolveChildResume>[1]);
  const codeOf = (fn: () => unknown): string | undefined => {
    try { fn(); return undefined; } catch (error) { return error instanceof ChildResumeError ? error.code : "unexpected"; }
  };

  test("only the delegating parent resumes; missing session or artifact is typed", () => {
    const registry = registryOf();
    expect(resolve(registry).plan).toMatchObject({ level: "L2", source: "default", restored: ["child_session"] });
    expect(codeOf(() => resolve(registry, { caller: { run: "r1.task.sibling", agent: "build" } }))).toBe("resume_forbidden");
    expect(codeOf(() => resolve(registry, { sessionId: "r1.task.gone" }))).toBe("session_missing");
    expect(codeOf(() => resolve(registryOf({ history: undefined })))).toBe("artifact_missing");
  });

  test("L2 reopens the live session, L1 only on request, a dead session rebuilds (L3)", () => {
    const registry = registryOf();
    const l2 = resolve(registry);
    expect([l2.plan.level, l2.history?.length]).toEqual(["L2", 1]);
    // L2 restores the session itself; nothing else is injected on top of it.
    expect([l2.prompt.includes("add the tests"), l2.prompt.includes("journal:"), l2.prompt.includes("implement the login screen")])
      .toEqual([true, false, false]);

    const l1 = resolve(registry, { requested: "L1" });
    // No artifact: L1 rebuilds from the live parent's memory, not the ledger.
    expect([l1.plan.source, l1.plan.restored, l1.history]).toEqual(["request", [], undefined]);
    expect(l1.prompt).toContain("implement the login screen");

    const l3 = resolve(registryOf({ history: undefined, artifact: artifact(), journal: { steps: 3, tokens: 640 } }));
    expect(l3.plan).toMatchObject({ level: "L3", source: "fallback", restored: ["brief", "journal"] });
    expect(l3.history).toBeUndefined();
    expect(l3.prompt).toContain("journal: 3 steps");
    expect(l3.prompt).toContain("implement the login screen");
    expect(codeOf(() => resolve(registry, { requested: "L3" }))).toBe("artifact_missing");
  });

  test("the resumed prompt bounds the instruction and the brief", () => {
    const bounded = resolve(registryOf({ brief: brief({ objective: "o".repeat(4000) }) }),
      { instruction: "i".repeat(RESUME_INSTRUCTION_MAX_CHARS + 500), requested: "L1" });
    expect([bounded.truncated, bounded.prompt.includes("i".repeat(RESUME_INSTRUCTION_MAX_CHARS + 1)), bounded.prompt.includes("o".repeat(201))])
      .toEqual([true, false, false]);
  });

  test("an evicted handle is session_missing", () => {
    const registry = new ChildSessionRegistry();
    for (let index = 0; index <= CHILD_SESSION_HANDLES_MAX; index += 1) registry.register(handle({ session: `r1.task.${index}` }));
    expect(codeOf(() => resolve(registry, { sessionId: "r1.task.0" }))).toBe("session_missing");
    expect(resolve(registry, { sessionId: `r1.task.${CHILD_SESSION_HANDLES_MAX}` }).plan.level).toBe("L2");
  });

  test("without a live handle, only the delegating parent rebuilds from the ledger artifact", () => {
    const ledgerArtifact = artifact();
    const rebuilt = resolveChildResume(new ChildSessionRegistry(), {
      sessionId: ledgerArtifact.run, instruction: "recover",
      caller: { run: "r1", agent: ledgerArtifact.from }, artifact: ledgerArtifact,
    });
    expect([rebuilt.handle, rebuilt.agent, rebuilt.plan.level, rebuilt.plan.source]).toEqual([undefined, ledgerArtifact.to, "L3", "fallback"]);
    expect(rebuilt.prompt).toContain("recover");
    expect(codeOf(() => resolveChildResume(new ChildSessionRegistry(), {
      sessionId: ledgerArtifact.run, instruction: "x", caller: { run: "r1", agent: "other" }, artifact: ledgerArtifact,
    }))).toBe("resume_forbidden");
  });

  test("createTaskTool refuses a resume from an agent that did not delegate", async () => {
    const registry = registryOf();
    const resume: TaskResumer = async (input) => {
      try {
        const resolved = resolveChildResume(registry, {
          sessionId: input.sessionId, instruction: input.instruction,
          ...(input.level === undefined ? {} : { requested: input.level }),
          caller: { run: input.run, agent: input.fromAgent },
        });
        return { status: "ok", output: resolved.prompt, sessionId: input.sessionId, level: resolved.plan.level, source: resolved.plan.source,
          restored: resolved.plan.restored, truncated: resolved.truncated };
      } catch (error) {
        if (error instanceof ChildResumeError) return { status: "error", error: error.code, message: error.message };
        throw error;
      }
    };
    const cwd = mkdtempSync(join(tmpdir(), "astro-resume-tool-"));
    const tool = createTaskTool({ audit: new Auditor(join(cwd, "audit.jsonl")), knownAgents: () => [], delegate: async () => "no", resume });
    const result = await tool.execute({ session_id: "r1.task.live", instruction: "continue" }, { cwd, run: "r1", agent: "qa" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ error: "resume_forbidden", session_id: "r1.task.live" });
  });
});

describe("task.resume live handle (ADR-0036, #602)", () => {
  const toolResult = (body: Body): Record<string, unknown> | undefined => {
    for (const message of [...body.messages].reverse()) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      try { return JSON.parse(message.content) as Record<string, unknown>; } catch { /* not a JSON result */ }
    }
    return undefined;
  };

  test("L2 reopens the live child with its own scope and returns the result to the parent", async () => {
    const instruction = "INSTRUCTION-MARKER add the tests";
    const h = harness({
      plan: (call, body) => call === 1 ? toolCall("task", { agent: "build", prompt: "implement" })
        : call === 2 ? toolCall("task", { session_id: String(toolResult(body)?.session_id), instruction })
          : final("parent-final"),
      child: (call) => call === 1 ? final("child-summary")
        : call === 2 ? toolCall("task", { agent: "plan", prompt: "grandchild" }) : final("child-continued"),
    });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: "PARENT-RESUME-TASK",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("parent-final");
      const childBodies = h.bodies.filter((body) => body.messages[0]?.content === "child-agent");
      const reopened = JSON.stringify(childBodies[1]!.messages);
      expect([childBodies.length, reopened.includes("child-summary"), reopened.includes(instruction)]).toEqual([3, true, true]);
      // I-01/I-02: the resumed child keeps its own allowlist, so no grandchild.
      expect(JSON.stringify(childBodies[2]!.messages)).toContain("permitida para o agent");
      expect(toolResult(h.bodies.at(-1)!)).toMatchObject({ level: "L2", source: "default", output: "child-continued" });
      expect(new Ledger(join(h.cwd, ".astro", "ledger.jsonl")).readHandoffs()).toHaveLength(0);
      expect(existsSync(join(h.cwd, ".astro", "sessions"))).toBe(false);
      const audit = readFileSync(join(h.cwd, ".astro", "audit.jsonl"), "utf8");
      expect([audit.includes(instruction), audit.includes("PARENT-RESUME-TASK")]).toEqual([false, false]);
      expect(new Auditor(join(h.cwd, ".astro", "audit.jsonl")).readAll().find((item) => item.tipo === "task.resumed")?.payload)
        .toMatchObject({ level: "L2", source: "default" });
    } finally { h.server.stop(true); }
  });

  test("a resume with no live session is typed, not a fresh child run", async () => {
    const h = harness({
      plan: (call) => call === 1 ? toolCall("task", { session_id: "r1.task.missing", instruction: "continue" })
        : call === 2 ? toolCall("task", { session_id: "not-a-session", instruction: "continue" })
          : final("parent-final"),
      child: () => final("should-not-run"),
    });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: "resume-missing",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      const results = h.bodies.at(-1)!.messages
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
      // A child id of another run is an explicit refusal; junk is missing.
      expect([result.final, h.calls.child, ...results.map((item) => item.error)])
        .toEqual(["parent-final", 0, "resume_forbidden", "session_missing"]);
    } finally { h.server.stop(true); }
  });

  test("a retryable resume failure keeps the live session for the next resume", async () => {
    const h = harness({
      plan: (call, body) => call === 1 ? toolCall("task", { agent: "build", prompt: "implement" })
        : call === 2 ? toolCall("task", { session_id: String(toolResult(body)?.session_id), instruction: "first attempt" })
          : call === 3 ? toolCall("task", { session_id: String(toolResult(body)?.session_id), instruction: "second attempt" })
            : final("parent-final"),
      // 5xx is a retryable class: it must not retire the live session.
      child: (call, body) => JSON.stringify(body.messages).includes("first attempt")
        ? new Response("provider outage", { status: 500 })
        : call === 1 ? final("child-summary") : final("child-continued"),
    }, { planSteps: 4 });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: "retry-resume",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("parent-final");
      const retried = h.bodies.find((body) => body.messages[0]?.content === "child-agent"
        && JSON.stringify(body.messages).includes("second attempt"));
      expect(retried).toBeDefined();
      expect(JSON.stringify(retried!.messages)).toContain("child-summary");
      expect(toolResult(h.bodies.at(-1)!)).toMatchObject({ level: "L2", source: "default", output: "child-continued" });
    } finally { h.server.stop(true); }
  });

  test("a 3000-character instruction reports the cut in the tool result", async () => {
    const instruction = "x".repeat(3000);
    const h = harness({
      plan: (call, body) => call === 1 ? toolCall("task", { agent: "build", prompt: "implement" })
        : call === 2 ? toolCall("task", { session_id: String(toolResult(body)?.session_id), instruction })
          : final("parent-final"),
      child: (call) => call === 1 ? final("child-summary") : final("child-continued"),
    });
    try {
      await runTask({ configPath: h.configPath, cwd: h.cwd, task: "truncated",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(toolResult(h.bodies.at(-1)!)).toMatchObject({ truncated: true, level: "L2" });
      const resumed = h.bodies.filter((body) => body.messages[0]?.content === "child-agent")[1]!;
      expect(JSON.stringify(resumed.messages)).not.toContain("x".repeat(RESUME_INSTRUCTION_MAX_CHARS + 1));
    } finally { h.server.stop(true); }
  });

  test("a failed child names its session so L3 is reachable", async () => {
    const h = harness({
      plan: (call, body) => call === 1 ? toolCall("task", { agent: "build", prompt: "implement" })
        : call === 2 ? toolCall("task", { session_id: String(toolResult(body)?.session_id), instruction: "recover" })
          : final("parent-final"),
      child: (call) => call === 1 ? new Response("bad request", { status: 400 })
        : call === 2 ? toolCall("task", { agent: "plan", prompt: "grandchild" })
          : final("child-recovered"),
    });
    try {
      const result = await runTask({ configPath: h.configPath, cwd: h.cwd, task: "recover-child",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("parent-final");
      // The failed result names the child run, survives the session sanitizer
      // and carries no artifact hash (a 64-hex id would be redacted).
      const failure = toolResult(h.bodies.find((body) => body.messages[0]?.content === "plan-agent"
        && body.messages.some((message) => message.role === "tool"))!);
      // Bun's toMatchObject may replace a matched property with its matcher, so
      // capture the id and assert it as a value before comparing with the ledger.
      const sessionId = failure?.session_id;
      expect(failure?.error).toBe("child_failed");
      expect(String(sessionId)).toContain(".task.");
      expect(failure).not.toHaveProperty("handoff_id");
      const created = new Ledger(join(h.cwd, ".astro", "ledger.jsonl")).readHandoffs()
        .filter((entry) => entry.kind === "handoff.created");
      expect(created).toHaveLength(1);
      expect(sessionId).toBe(created[0]!.artifact.run);
      // The default resume of a dead session with an artifact is the L3 fallback,
      // and the rebuilt child keeps its own allowlist (no grandchild, I-01/I-02).
      const childBodies = h.bodies.filter((body) => body.messages[0]?.content === "child-agent");
      const prompt = JSON.stringify(childBodies[1]!.messages);
      expect([prompt.includes("recover"), prompt.includes("child build"), prompt.includes("implement")]).toEqual([true, true, false]);
      expect(JSON.stringify(childBodies[2]!.messages)).toContain("permitida para o agent");
      expect(toolResult(h.bodies.at(-1)!)).toMatchObject({ level: "L3", source: "fallback", output: "child-recovered" });
    } finally { h.server.stop(true); }
  });

  test("an evicted handle rebuilds for a long-named run and audits the new run", async () => {
    // A child id longer than 160 chars must still rebuild: the lookup is gated
    // by the parent-run prefix, not by a magic length cap.
    const longRun = "run".repeat(40);
    const failureSession = (body: Body): string => {
      for (const message of body.messages) {
        if (message.role !== "tool" || !String(message.content).includes("child_failed")) continue;
        try { return String((JSON.parse(String(message.content)) as { session_id?: string }).session_id ?? ""); } catch { /* not json */ }
      }
      return "";
    };
    const h = harness({
      plan: (call, body) => call === 1 ? toolCall("task", { agent: "build", prompt: "first fails" })
        : call <= 33 ? toolCall("task", { agent: "build", prompt: `filler ${call}` })
          : call === 34 ? toolCall("task", { session_id: failureSession(body), instruction: "recover" })
            : final("parent-final"),
      child: (call, body) => JSON.stringify(body.messages).includes("first fails")
        ? new Response("bad request", { status: 400 })
        : final(JSON.stringify(body.messages).includes("recover") ? "child-recovered" : "filler-ok"),
    }, { planSteps: 40, rounds: 40 });
    try {
      const result = await runTask({ runId: longRun, configPath: h.configPath, cwd: h.cwd, task: "evict-child",
        env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
      expect(result.final).toBe("parent-final");
      const failed = failureSession(h.bodies.at(-1)!);
      const rebuilt = toolResult(h.bodies.at(-1)!);
      expect([failed.startsWith(`${longRun}.task.`), failed.length > 160]).toEqual([true, true]);
      // The 33rd delegation evicted the failed handle: the resume rebuilt from
      // the ledger artifact, so the result names a new run.
      expect(rebuilt).toMatchObject({ level: "L3", source: "fallback", output: "child-recovered" });
      expect([failed.length > 0, rebuilt?.session_id === failed]).toEqual([true, false]);
      // The audit keeps the chain: requested session -> rebuilt run.
      expect(new Auditor(join(h.cwd, ".astro", "audit.jsonl")).readAll()
        .filter((item) => item.tipo === "task.resumed").at(-1)?.payload)
        .toMatchObject({ session: failed, resumedSession: rebuilt?.session_id });
    } finally { h.server.stop(true); }
  }, 180000);
});
