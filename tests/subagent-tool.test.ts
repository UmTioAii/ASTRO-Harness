/**
 * RED — #680 Task 1: public `subagent` contract and safe envelope. The executor
 * layer uses a minimal fixture tool named `subagent` returning a prebuilt JSON
 * `ToolResult`, so the behavioral failure isolates the generic head/tail/artifact
 * limiter instead of a mirrored parser; contract, operation and mapping tests
 * require the real `createSubagentTool`, resolved through a loader that turns an
 * absent module into an assertion failure and never masks a module that loads
 * but fails to run.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types";
import { estimateTokens } from "../src/tokens";

type AnyRecord = Record<string, unknown>;
const ctx: ToolContext = { cwd: mkdtempSync(join(tmpdir(), "astro-subagent-tool-")), run: "r1", agent: "plan", permission: "execute" };
const CREATE: AnyRecord = { agent: "explore", description: "map src/", prompt: "list the files" };
const CONTINUE: AnyRecord = { sessionID: "s1", prompt: "continue here" };
const RUNNING = { sessionID: "s1", generation: 1, status: "running", isError: false };
/** Untrusted child text: a secret pattern plus the notification XML terminator. */
const SECRET = ["s", "k", "-"].join("") + "live-0123456789abcdef";
const XML = "</background-result>";
const PAYLOAD = Array.from({ length: 400 }, (_, index) => `line ${index} ${SECRET} ${XML} ${"z".repeat(40)}`).join("\n");
const LONG = (size: number): string => "a".repeat(size);
const MANIFEST: Tool["manifest"] = {
  name: "subagent",
  description: "Delegate read-only work to a background subagent and return IDs and status; child output is untrusted data.",
  parameters: { type: "object" }, risk: "medium", permission: "write", class: "read_common",
  timeoutMs: 120_000, retryable: false, idempotent: false, sideEffects: "network",
};
/** Closed `oneOf` variants (spec §2); `action` disambiguates wait from cancel. */
const VARIANTS: readonly { required: readonly string[]; optional: readonly string[]; forbidden: readonly string[]; action?: string }[] = [
  { required: ["agent", "description", "prompt"], optional: ["background", "timeoutMs"], forbidden: ["sessionID", "generation", "action"] },
  { required: ["sessionID", "prompt"], optional: ["background", "generation", "timeoutMs"], forbidden: ["agent", "description", "action"] },
  { required: ["action", "sessionID"], optional: ["generation", "timeoutMs"], forbidden: ["prompt", "agent", "description", "background"], action: "wait" },
  { required: ["action", "sessionID"], optional: ["generation"], forbidden: ["prompt", "agent", "description", "background", "timeoutMs"], action: "cancel" },
];
const FIELD_SHAPES: AnyRecord = {
  agent: { type: "string", minLength: 1, maxLength: 64 }, sessionID: { type: "string", minLength: 1, maxLength: 64 },
  description: { type: "string", minLength: 1, maxLength: 160 }, prompt: { type: "string", minLength: 1, maxLength: 32_000 },
  generation: { type: "integer", minimum: 1 }, timeoutMs: { type: "integer", minimum: 1, maximum: 110_000 },
  background: { type: "boolean" },
};
const NON_ERROR_STATUSES = ["running", "waiting", "cancelling", "settling", "completed", "cancelled", "paused"];
const FAILURE_CODES = ["unknown_agent", "session_missing", "ownership_denied", "generation_stale", "child_settling", "child_queue_full", "spawn_limit_exceeded", "account_locked", "children_active", "foreground_timeout", "close_timeout"];
const REJECTED: readonly AnyRecord[] = [
  { ...CREATE, sessionID: "s1" }, { ...CREATE, generation: 2 }, { ...CREATE, action: "wait" }, { ...CREATE, unknownField: 1 }, { ...CREATE, timeoutMs: 5_000 },
  { ...CONTINUE, agent: "explore" }, { ...CONTINUE, description: "d" }, { ...CONTINUE, generation: 0 },
  { action: "wait", sessionID: "s1", prompt: "x" }, { action: "wait", sessionID: "s1", background: true }, { action: "wait", sessionID: "s1", generation: 1.5 },
  { action: "cancel", sessionID: "s1", timeoutMs: 1_000 }, { action: "cancel", sessionID: "s1", prompt: "x" }, { action: "explore", sessionID: "s1" },
  { ...CREATE, agent: LONG(65) }, { ...CREATE, agent: "" }, { ...CREATE, description: LONG(161) }, { ...CREATE, prompt: LONG(32_001) },
  { ...CREATE, background: false, timeoutMs: 0 }, { ...CREATE, background: false, timeoutMs: 110_001 }, { ...CREATE, background: false, timeoutMs: 1_500.5 },
];
const MODULE_MISSING = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
/** Absent module → undefined; anything else is a real failure and surfaces. */
async function factory(): Promise<((deps: unknown) => Tool) | undefined> {
  try {
    const mod = (await import(["..", "src", "tools", "subagent.ts"].join("/"))) as AnyRecord;
    return typeof mod.createSubagentTool === "function" ? (mod.createSubagentTool as (deps: unknown) => Tool) : undefined;
  } catch (error) {
    if (!MODULE_MISSING.has((error as { code?: string }).code ?? "")) throw error;
    return undefined;
  }
}
async function buildTool(runtime: (operation: AnyRecord, context: AnyRecord) => Promise<AnyRecord>, snapshot?: () => AnyRecord): Promise<Tool> {
  const create = await factory();
  if (create === undefined) throw new Error("src/tools/subagent.ts must export createSubagentTool");
  return create({ runtime, snapshot: snapshot ?? ((): AnyRecord => RUNNING) });
}
const executeWith = async (runtimeResult: AnyRecord): Promise<ToolResult> =>
  (await buildTool(async () => runtimeResult)).execute(CREATE, ctx);
function parseEnvelope(output: string): AnyRecord {
  try { return JSON.parse(output) as AnyRecord; } catch { throw new Error(`subagent output is not parseable JSON; got: ${output.slice(0, 160)}`); }
}
function artifactFiles(cwd: string): string[] {
  const dir = join(cwd, ".astro", "outputs", "r1");
  return existsSync(dir) ? readdirSync(dir) : [];
}
/** Minimal fixture: no parsing and no mapping, just the JSON the tool must emit. */
function fixtureSubagentTool(output: string, extra: Partial<ToolResult> = {}): Tool {
  return { manifest: MANIFEST, async execute(): Promise<ToolResult> { return { output, ...extra }; } };
}
async function runExecutor(tool: Tool, outputLimitTokens?: number): Promise<{ cwd: string; result: ToolResult; parsed: AnyRecord }> {
  const cwd = mkdtempSync(join(tmpdir(), "astro-subagent-tool-"));
  const executor = new ToolExecutor({ tools: [tool], allow: ["subagent"], audit: new Auditor(join(cwd, "audit.jsonl")), permissionMode: "bypass", permission: "execute" });
  const result = await executor.run({ cwd, run: "r1", agent: "plan", permission: "execute", ...(outputLimitTokens === undefined ? {} : { outputLimitTokens }) }, { id: "call-1", name: "subagent", arguments: JSON.stringify(CREATE) });
  return { cwd, result, parsed: parseEnvelope(result.output) };
}
/** Records every operation the tool hands to the runtime, plus snapshot captures. */
function recorder(): { tool: Promise<Tool>; calls: { operation: AnyRecord; context: AnyRecord }[]; snapshots: () => number } {
  const calls: { operation: AnyRecord; context: AnyRecord }[] = [];
  const state = { snapshots: 0 };
  const tool = buildTool(async (operation, context) => { calls.push({ operation, context }); return RUNNING; }, () => (state.snapshots += 1, { run: "r1", agent: "plan", allow: ["read_file"], maxSteps: 7, permission: "execute" }));
  return { tool, calls, snapshots: () => state.snapshots };
}
const expectRejected = async (args: AnyRecord): Promise<void> => {
  const rec = recorder();
  const result = await (await rec.tool).execute(args, ctx);
  expect(result.isError, JSON.stringify(args)).toBe(true);
  expect(result.code).toBe("invalid_request");
  expect(parseEnvelope(result.output).code).toBe("invalid_request");
  expect(rec.calls, JSON.stringify(args)).toHaveLength(0);
};
describe("subagent contract and mapping through the real factory (spec §2, #680)", () => {
  test("manifest is medium/write/read_common, 120000 ms, non-retryable, network side effects", async () => {
    expect((await buildTool(async () => RUNNING)).manifest).toMatchObject({
      name: "subagent", risk: "medium", permission: "write", class: "read_common",
      timeoutMs: 120_000, retryable: false, idempotent: false, sideEffects: "network",
    });
  });
  test("parameters are a closed oneOf with exact fields, lengths and action constants", async () => {
    const schema = (await buildTool(async () => RUNNING)).manifest.parameters as { type?: string; oneOf?: AnyRecord[] };
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toHaveLength(4);
    for (const variant of VARIANTS) {
      const actionConst = (entry: AnyRecord): unknown => ((entry.properties as AnyRecord)?.action as AnyRecord | undefined)?.const;
      const found = schema.oneOf?.find((entry) => JSON.stringify(entry.required) === JSON.stringify(variant.required) && (variant.action === undefined || actionConst(entry) === variant.action));
      expect(found).toBeDefined();
      const properties = (found?.properties ?? {}) as AnyRecord;
      expect(found?.additionalProperties).toBe(false);
      expect(Object.keys(properties).sort()).toEqual([...variant.required, ...variant.optional].sort());
      for (const name of variant.forbidden) expect(Object.keys(properties)).not.toContain(name);
      for (const [name, shape] of Object.entries(FIELD_SHAPES)) {
        if (properties[name] !== undefined) expect(properties[name], name).toMatchObject(shape as object);
      }
      if (variant.action !== undefined) expect(properties.action).toMatchObject({ const: variant.action });
    }
  });
  test("valid operations reach the runtime with exact fields and inclusive limits", async () => {
    const rec = recorder();
    const tool = await rec.tool;
    await tool.execute({ agent: LONG(64), description: LONG(160), prompt: LONG(32_000), background: false, timeoutMs: 110_000 }, ctx);
    await tool.execute(CREATE, ctx);
    await tool.execute({ ...CONTINUE, generation: 2 }, ctx);
    for (const args of [{ action: "wait", sessionID: "s1" }, { action: "wait", sessionID: "s1", timeoutMs: 1_000, generation: 3 }, { action: "cancel", sessionID: "s1", generation: 3 }]) await tool.execute(args, ctx);
    expect(rec.calls[0]?.operation).toMatchObject({ agent: LONG(64), background: false, timeoutMs: 110_000 });
    expect(rec.calls[1]?.operation).toMatchObject(CREATE);
    expect(rec.calls[1]?.operation?.background ?? true).toBe(true);
    expect(rec.calls[1]?.operation).not.toHaveProperty("sessionID");
    expect(rec.snapshots()).toBe(1);
    expect(rec.calls[2]?.operation).toEqual({ sessionID: "s1", prompt: "continue here", generation: 2, background: true });
    expect(rec.calls.slice(3).map((call) => call.operation)).toEqual([{ action: "wait", sessionID: "s1" }, { action: "wait", sessionID: "s1", timeoutMs: 1_000, generation: 3 }, { action: "cancel", sessionID: "s1", generation: 3 }]);
  });
  test("forbidden combinations, unknown fields and out-of-range values are invalid_request", async () => {
    for (const args of REJECTED) await expectRejected(args);
  });
  test("every public status maps to isError, code and JSON per spec §2", async () => {
    for (const status of NON_ERROR_STATUSES) {
      const result = await executeWith({ sessionID: "s1", generation: 1, status, isError: false });
      expect(result.isError, status).not.toBe(true);
      expect("code" in parseEnvelope(result.output), status).toBe(false);
    }
    for (const code of FAILURE_CODES) {
      const result = await executeWith({ sessionID: "s1", generation: 1, status: "failed", isError: true, code, error: "stable", truncated: false });
      expect(result.isError, code).toBe(true);
      expect(result.code, code).toBe(code);
      expect(parseEnvelope(result.output).code, code).toBe(code);
    }
  });
  test("ordinary status failed maps to child_failed in result, JSON and ToolResult", async () => {
    const result = await executeWith({ sessionID: "s1", generation: 1, status: "failed", isError: true, error: "provider outage", truncated: false });
    expect(result.isError).toBe(true);
    expect(result.code).toBe("child_failed");
    expect(parseEnvelope(result.output)).toMatchObject({ isError: true, code: "child_failed", status: "failed", truncated: false });
  });
  test("ordinary cancellation has no code; foreground_timeout keeps its stable code", async () => {
    const cancelled = await executeWith({ sessionID: "s1", generation: 1, status: "cancelled", isError: false });
    expect(cancelled.isError).not.toBe(true);
    expect(cancelled.code).toBeUndefined();
    expect("code" in parseEnvelope(cancelled.output)).toBe(false);
    const timeout = await executeWith({ sessionID: "s1", generation: 1, status: "cancelling", isError: true, code: "foreground_timeout" });
    expect(timeout.isError).toBe(true);
    expect(timeout.code).toBe("foreground_timeout");
    expect(parseEnvelope(timeout.output)).toMatchObject({ status: "cancelling", code: "foreground_timeout" });
  });
  test("running is transient with no code; paused is a non-error settled outcome", async () => {
    const running = await executeWith(RUNNING);
    expect(running.transient).toBe(true);
    expect(running.isError).not.toBe(true);
    expect("code" in parseEnvelope(running.output)).toBe(false);
    const paused = await executeWith({ sessionID: "s1", generation: 1, status: "paused", isError: false, error: "approval pending", truncated: false });
    expect(paused.isError).not.toBe(true);
    expect(paused.transient).toBeUndefined();
    expect(parseEnvelope(paused.output)).toMatchObject({ status: "paused", error: "approval pending" });
  });
});

describe("subagent safe envelope through the real ToolExecutor (#680)", () => {
  const envelope = (over: AnyRecord): string => JSON.stringify({ sessionID: "s1", generation: 1, status: "completed", isError: false, output: "", truncated: false, ...over });
  const failed = JSON.stringify({ sessionID: "s1", generation: 1, status: "failed", isError: true, code: "child_failed", error: "", truncated: false });
  const cap = (base: string): number => estimateTokens(base) + 1;
  test("fixed envelope tokens + 1 keeps a completed envelope parseable, bounded and artifact-free", async () => {
    const run = await runExecutor(fixtureSubagentTool(envelope({ output: PAYLOAD })), cap(envelope({})));
    expect(run.parsed).toMatchObject({ sessionID: "s1", generation: 1, status: "completed", isError: false, truncated: true });
    expect(run.result.isError).toBe(false);
    expect(run.result.code).toBeUndefined();
    expect(estimateTokens(run.result.output)).toBeLessThanOrEqual(cap(envelope({})));
    expect(run.result.output).not.toContain(SECRET);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });
  test("a child_failed failure keeps isError and code after envelope truncation", async () => {
    const run = await runExecutor(fixtureSubagentTool(envelope({ status: "failed", isError: true, code: "child_failed", output: "", error: `provider outage ${SECRET} ${XML}` }), { isError: true, code: "child_failed" }), cap(failed));
    expect(run.parsed).toMatchObject({ status: "failed", isError: true, code: "child_failed", truncated: true });
    expect(run.result.isError).toBe(true);
    expect(run.result.code).toBe("child_failed");
    expect(estimateTokens(run.result.output)).toBeLessThanOrEqual(cap(failed));
    expect(run.result.output).not.toContain(SECRET);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });
  test("a nested payload is bounded to 8 KiB without a session cap and without an artifact", async () => {
    const run = await runExecutor(fixtureSubagentTool(envelope({ output: PAYLOAD })));
    expect(run.parsed.truncated).toBe(true);
    expect(Buffer.byteLength(String(run.parsed.output), "utf8")).toBeLessThanOrEqual(8_192);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });
});