/**
 * `subagent` public contract and safe envelope (#680, spec §2/§5).
 *
 * The contract and mapping suites drive the real `createSubagentTool`; the safe
 * envelope suite drives the real factory through the real `ToolExecutor`, plus a
 * minimal output-only fixture for the limiter's own malformed-input contract.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { SUBAGENT_LIMITS, type SubagentResult } from "../src/subagents/types";
import { createSubagentTool } from "../src/tools/subagent";
import { ToolExecutor } from "../src/tools/executor";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types";
import { estimateTokens } from "../src/tokens";

type AnyRecord = Record<string, unknown>;
const ctx: ToolContext = { cwd: mkdtempSync(join(tmpdir(), "astro-subagent-tool-")), run: "r1", agent: "plan", permission: "execute" };
const CREATE: AnyRecord = { agent: "explore", description: "map src/", prompt: "list the files" };
const CONTINUE: AnyRecord = { sessionID: "s1", prompt: "continue here" };
const SECRET = ["s", "k", "-"].join("") + "live-0123456789abcdef";
const CLOSE_TAG = "</background-result>";
const PAYLOAD = Array.from({ length: 400 }, (_, index) => `line ${index} ${SECRET} ${CLOSE_TAG} ${"z".repeat(40)}`).join("\n");
const LONG = (size: number): string => "u".repeat(size);

/** Exact UTF-8 byte size mixing 4-byte emoji, 2-byte accents and 3-byte CJK. */
const utf8Bytes = (size: number): string => {
  const units = ["\u{1F600}", "é", "中", "a"];
  let text = "";
  let index = 0;
  while (Buffer.byteLength(text, "utf8") < size) {
    const next = text + units[index % units.length]!;
    if (Buffer.byteLength(next, "utf8") > size) return text + "a".repeat(size - Buffer.byteLength(text, "utf8"));
    text = next;
    index += 1;
  }
  return text;
};

/** Test runtime/snapshot fakes stay loosely typed by design; only the boundary is cast. */
type LooseRuntime = (operation: AnyRecord, context: AnyRecord) => Promise<AnyRecord>;
function buildTool(runtime: LooseRuntime, snapshot: () => AnyRecord = (): AnyRecord => ({ run: "r1", agent: "plan", cwd: "/tmp", allow: ["read_file"], maxSteps: 7, permission: "execute" })): Tool {
  return createSubagentTool({ runtime: { execute: runtime }, snapshot } as unknown as Parameters<typeof createSubagentTool>[0]);
}

function parseEnvelope(output: string): AnyRecord {
  try {
    return JSON.parse(output) as AnyRecord;
  } catch {
    throw new Error(`subagent output is not parseable JSON; got: ${output.slice(0, 160)}`);
  }
}

function artifactFiles(cwd: string): string[] {
  const dir = join(cwd, ".astro", "outputs", "r1");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Output-only fixture: the limiter must police arbitrary tool output on its own. */
function outputTool(output: string, name = "subagent", extra: Partial<ToolResult> = {}): Tool {
  return {
    manifest: { name, description: "fixture", parameters: { type: "object" }, risk: "medium", permission: "write", class: "read_common", timeoutMs: 120_000, retryable: false, idempotent: false, sideEffects: "network" },
    async execute(): Promise<ToolResult> { return { output, ...extra }; },
  };
}

async function runExecutor(tool: Tool, outputLimitTokens?: number, args: AnyRecord = CREATE): Promise<{ cwd: string; result: ToolResult; parsed: AnyRecord }> {
  const cwd = mkdtempSync(join(tmpdir(), "astro-subagent-tool-"));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const executor = new ToolExecutor({ tools: [tool], allow: [tool.manifest.name], audit, permissionMode: "bypass", permission: "execute" });
  const result = await executor.run({ cwd, run: "r1", agent: "plan", permission: "execute", ...(outputLimitTokens === undefined ? {} : { outputLimitTokens }) }, { id: "call-1", name: tool.manifest.name, arguments: JSON.stringify(args) });
  return { cwd, result, parsed: parseEnvelope(result.output) };
}

/** Result the runtime hands back for a status; settled and failure shapes per spec §2. */
function statusResult(status: string, code?: string): AnyRecord {
  const ids = { sessionID: "s1", generation: 1, status };
  if (code !== undefined) return { ...ids, isError: true, code, error: "stable", truncated: false };
  return status === "completed" || status === "cancelled" || status === "paused"
    ? { ...ids, isError: false, output: "final", truncated: false }
    : { ...ids, isError: false };
}

function recorder(): { tool: Tool; calls: { operation: AnyRecord; context: AnyRecord }[]; snapshots: () => number } {
  const calls: { operation: AnyRecord; context: AnyRecord }[] = [];
  const state = { snapshots: 0 };
  const tool = buildTool(async (operation, context) => { calls.push({ operation, context }); return statusResult("running"); }, () => {
    state.snapshots += 1;
    return { run: "r1", agent: "plan", allow: ["read_file"], maxSteps: 7, permission: "execute" };
  });
  return { tool, calls, snapshots: () => state.snapshots };
}

const RUNNING = statusResult("running");
const SETTLED = ["completed", "cancelled", "paused"];
const NON_ERROR_STATUSES = ["running", "waiting", "cancelling", "settling", "completed", "cancelled", "paused"];
const FAILURE_CODES = ["unknown_agent", "session_missing", "ownership_denied", "generation_stale", "child_settling",
  "child_queue_full", "spawn_limit_exceeded", "account_locked", "children_active", "foreground_timeout", "close_timeout"];
const VARIANTS: readonly { required: readonly string[]; optional: readonly string[]; forbidden: readonly string[]; action?: string }[] = [
  { required: ["agent", "description", "prompt"], optional: ["background", "timeoutMs"], forbidden: ["sessionID", "generation", "action"] },
  { required: ["sessionID", "prompt"], optional: ["background", "generation", "timeoutMs"], forbidden: ["agent", "description", "action"] },
  { required: ["action", "sessionID"], optional: ["generation", "timeoutMs"], forbidden: ["prompt", "agent", "description", "background"], action: "wait" },
  { required: ["action", "sessionID"], optional: ["generation"], forbidden: ["prompt", "agent", "description", "background", "timeoutMs"], action: "cancel" },
];
const FIELD_SHAPES: Record<string, object> = {
  agent: { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.idMaxChars }, sessionID: { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.idMaxChars },
  description: { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.descriptionMaxChars }, prompt: { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.promptMaxChars },
  generation: { type: "integer", minimum: 1 }, timeoutMs: { type: "integer", minimum: 1, maximum: SUBAGENT_LIMITS.timeoutMaxMs }, background: { type: "boolean" },
};
const REJECTED: readonly AnyRecord[] = [
  { ...CREATE, sessionID: "s1" }, { ...CREATE, generation: 2 }, { ...CREATE, action: "wait" }, { ...CREATE, unknownField: 1 }, { ...CREATE, timeoutMs: 5_000 },
  { ...CONTINUE, agent: "explore" }, { ...CONTINUE, description: "d" }, { ...CONTINUE, generation: 0 },
  { action: "wait", sessionID: "s1", prompt: "x" }, { action: "wait", sessionID: "s1", background: true }, { action: "wait", sessionID: "s1", generation: 1.5 },
  { action: "cancel", sessionID: "s1", timeoutMs: 1_000 }, { action: "cancel", sessionID: "s1", prompt: "x" }, { action: "explore", sessionID: "s1" },
  { ...CREATE, agent: LONG(65) }, { ...CREATE, agent: "" }, { ...CREATE, description: LONG(161) }, { ...CREATE, prompt: LONG(32_001) },
  { ...CREATE, background: false, timeoutMs: 0 }, { ...CREATE, background: false, timeoutMs: 110_001 }, { ...CREATE, background: false, timeoutMs: 1_500.5 },
];
const expectRejected = async (args: AnyRecord): Promise<void> => {
  const result = await buildTool(async () => RUNNING).execute(args, ctx);
  expect(result.isError, JSON.stringify(args)).toBe(true);
  expect(result.transient, JSON.stringify(args)).toBe(true);
  expect(result.code).toBe("invalid_request");
  expect(parseEnvelope(result.output).code).toBe("invalid_request");
};

describe("subagent closed result union (spec §2, #680)", () => {
  test("missing IDs, code on success, non-error failed and missing settled fields are type errors", () => {
    const ids = { sessionID: "s1", generation: 1 };
    // @ts-expect-error an accepted result requires real IDs and generation
    const missingIds: SubagentResult = { isError: false, status: "completed", truncated: false, output: "" };
    // @ts-expect-error a non-error result never carries a code
    const withCode: SubagentResult = { isError: false, code: "child_failed", ...ids, status: "completed", truncated: false, output: "" };
    // @ts-expect-error an ordinary failed outcome cannot be non-error, even with a complete payload
    const nonErrorFailed: SubagentResult = { isError: false, ...ids, status: "failed", truncated: false, output: "o" };
    // @ts-expect-error a settled result requires `truncated` and a bounded payload
    const missingSettled: SubagentResult = { isError: false, ...ids, status: "completed" };
    // @ts-expect-error a pre-identity failure carries neither ID field, not sessionID only
    const partialIdentity: SubagentResult = { isError: true, code: "unknown_agent", sessionID: "s1", status: "failed", truncated: false, error: "" };
    // @ts-expect-error a pre-identity failure carries neither ID field, not generation only
    const partialGeneration: SubagentResult = { isError: true, code: "unknown_agent", generation: 1, status: "failed", truncated: false, error: "" };
    // @ts-expect-error an identified settled failure requires a bounded payload
    const settledWithoutPayload: SubagentResult = { isError: true, code: "child_failed", ...ids, status: "failed", truncated: false };
    // @ts-expect-error an identified settled failure carries exactly one payload
    const settledWithBoth: SubagentResult = { isError: true, code: "child_failed", ...ids, status: "failed", truncated: false, output: "o", error: "e" };
    const settledOutput: SubagentResult = { isError: true, code: "child_failed", ...ids, status: "failed", truncated: false, output: "o" };
    const settledError: SubagentResult = { isError: true, code: "child_failed", ...ids, status: "failed", truncated: false, error: "e" };
    expect([missingIds, withCode, nonErrorFailed, missingSettled, partialIdentity, partialGeneration, settledWithoutPayload, settledWithBoth, settledOutput, settledError]).toHaveLength(10);
  });
});

describe("subagent contract and mapping through the real factory (spec §2)", () => {
  test("manifest is medium/write/read_common, 120000 ms, non-retryable, network side effects", async () => {
    expect(buildTool(async () => RUNNING).manifest).toMatchObject({
      name: "subagent", risk: "medium", permission: "write", class: "read_common",
      timeoutMs: 120_000, retryable: false, idempotent: false, sideEffects: "network",
    });
  });

  test("parameters are a closed oneOf with exact fields, lengths and action constants", async () => {
    const schema = buildTool(async () => RUNNING).manifest.parameters as { type?: string; oneOf?: AnyRecord[] };
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
        if (properties[name] !== undefined) expect(properties[name], name).toMatchObject(shape);
      }
      if (variant.action !== undefined) expect(properties.action).toMatchObject({ const: variant.action });
    }
  });

  test("the schema forbids timeoutMs without an explicit background:false on create and continue only", async () => {
    const schema = buildTool(async () => RUNNING).manifest.parameters as { oneOf?: AnyRecord[] };
    const rule = (index: number): AnyRecord | undefined => ((schema.oneOf?.[index]?.allOf ?? []) as AnyRecord[])[0];
    for (const index of [0, 1]) {
      expect(rule(index), `variant ${index}`).toMatchObject({
        if: { required: ["timeoutMs"] },
        then: { required: ["background"], properties: { background: { const: false } } },
      });
    }
    expect(rule(2)).toBeUndefined();
    expect(rule(3)).toBeUndefined();
    const withTimeout = await buildTool(async () => RUNNING).execute({ ...CREATE, timeoutMs: 5_000 }, ctx);
    expect(withTimeout.isError).toBe(true);
    expect(withTimeout.code).toBe("invalid_request");
  });

  test("valid operations reach the runtime with exact fields and inclusive limits", async () => {
    const rec = recorder();
    await rec.tool.execute({ agent: LONG(64), description: LONG(160), prompt: LONG(32_000), background: false, timeoutMs: 110_000 }, ctx);
    await rec.tool.execute(CREATE, ctx);
    await rec.tool.execute({ ...CONTINUE, generation: 2 }, ctx);
    for (const args of [{ action: "wait", sessionID: "s1" }, { action: "wait", sessionID: "s1", timeoutMs: 1_000, generation: 3 }, { action: "cancel", sessionID: "s1", generation: 3 }]) await rec.tool.execute(args, ctx);
    expect(rec.calls[0]?.operation).toMatchObject({ agent: LONG(64), background: false, timeoutMs: 110_000 });
    expect(rec.calls[1]?.operation).toMatchObject(CREATE);
    expect(rec.calls[1]?.operation?.background ?? true).toBe(true);
    expect(rec.calls[1]?.operation).not.toHaveProperty("sessionID");
    expect(rec.snapshots()).toBe(2); // one capture per create
    expect(rec.calls[2]?.operation).toEqual({ sessionID: "s1", prompt: "continue here", generation: 2, background: true });
    expect(rec.calls.slice(3).map((call) => call.operation)).toEqual([{ action: "wait", sessionID: "s1" }, { action: "wait", sessionID: "s1", timeoutMs: 1_000, generation: 3 }, { action: "cancel", sessionID: "s1", generation: 3 }]);
  });

  test("forbidden combinations, unknown fields and out-of-range values are invalid_request", async () => {
    for (const args of REJECTED) await expectRejected(args);
  });

  test("every public status maps to isError, code and JSON per spec §2", async () => {
    for (const status of NON_ERROR_STATUSES) {
      const result = await buildTool(async () => statusResult(status)).execute(CREATE, ctx);
      expect(result.isError, status).not.toBe(true);
      expect(result.code, status).toBeUndefined();
      const parsed = parseEnvelope(result.output);
      expect(parsed.status, status).toBe(status);
      expect("code" in parsed, status).toBe(false);
      if (SETTLED.includes(status)) expect(parsed.truncated, status).toBe(false);
    }
    for (const code of FAILURE_CODES) {
      const result = await buildTool(async () => statusResult("failed", code)).execute(CREATE, ctx);
      expect(result.isError, code).toBe(true);
      expect(result.code, code).toBe(code);
      expect(parseEnvelope(result.output).code, code).toBe(code);
    }
  });

  test("an ordinary failed outcome is isError with child_failed whatever the discriminator said", async () => {
    for (const isError of [false, undefined]) {
      const result = await buildTool(async () => ({ sessionID: "s1", generation: 1, status: "failed", isError, error: "provider outage", truncated: false })).execute(CREATE, ctx);
      expect(result.isError, String(isError)).toBe(true);
      expect(result.code).toBe("child_failed");
      expect(parseEnvelope(result.output)).toMatchObject({ isError: true, code: "child_failed", status: "failed", truncated: false, error: "provider outage" });
    }
    const coded = await buildTool(async () => ({ sessionID: "s1", generation: 1, status: "failed", isError: false, code: "foreground_timeout", error: "deadline", truncated: false })).execute(CREATE, ctx);
    expect(coded.code).toBe("foreground_timeout");
  });

  test("a well-formed pre-identity failure keeps its stable code, error and no IDs", async () => {
    for (const code of ["invalid_request", "unknown_agent"]) {
      const runtimeResult = { isError: true, code, status: "failed", error: `missing ${SECRET}`, truncated: false };
      const direct = await buildTool(async () => runtimeResult).execute(CREATE, ctx);
      expect(direct.isError, code).toBe(true);
      expect(direct.code, code).toBe(code);
      expect(parseEnvelope(direct.output), code).toEqual({ isError: true, code, status: "failed", truncated: false, error: `missing [REDACTED]` });
      expect(direct.output, code).not.toContain(SECRET);

      const throughExecutor = await runExecutor(buildTool(async () => runtimeResult));
      expect(throughExecutor.result.code, code).toBe(code);
      expect(throughExecutor.result.transient, code).toBe(true);
      expect(throughExecutor.parsed, code).toEqual({ isError: true, code, status: "failed", truncated: false, error: `missing [REDACTED]` });
      expect(throughExecutor.parsed, code).not.toHaveProperty("sessionID");
      expect(throughExecutor.parsed, code).not.toHaveProperty("generation");
      expect(artifactFiles(throughExecutor.cwd), code).toEqual([]);

      const limited = await runExecutor(outputTool(JSON.stringify(runtimeResult)));
      expect(limited.result.code, code).toBe(code);
      expect(limited.parsed, code).toEqual({ isError: true, code, status: "failed", truncated: false, error: `missing [REDACTED]` });
    }
    // A refused call keeps its own code through the executor instead of becoming child_failed.
    const refused = await runExecutor(buildTool(async () => RUNNING), undefined, { agent: "explore" });
    expect(refused.result.code).toBe("invalid_request");
    expect(refused.parsed).toEqual({ isError: true, code: "invalid_request", status: "failed", truncated: false, error: "field 'description' is required" });
  });

  test("a secret-shaped identity is refused instead of emitted (I-03)", async () => {
    const secretIdentity = { sessionID: SECRET, generation: 1 };
    const shapes: AnyRecord[] = [
      { ...secretIdentity, status: "completed", isError: false, output: "safe", truncated: false },
      { ...secretIdentity, status: "failed", isError: true, code: "child_failed", error: "boom", truncated: false },
      { ...secretIdentity, status: "cancelling", isError: true, code: "foreground_timeout", error: "deadline", truncated: false },
    ];
    for (const runtimeResult of shapes) {
      const direct = await buildTool(async () => runtimeResult).execute(CREATE, ctx);
      expect(direct.code, JSON.stringify(runtimeResult)).toBe("child_failed");
      expect(direct.output, JSON.stringify(runtimeResult)).not.toContain(SECRET);
      expect(parseEnvelope(direct.output), JSON.stringify(runtimeResult)).toEqual({ isError: true, code: "child_failed", status: "failed", truncated: false, error: "" });

      const throughExecutor = await runExecutor(buildTool(async () => runtimeResult));
      expect(throughExecutor.result.code, JSON.stringify(runtimeResult)).toBe("child_failed");
      expect(throughExecutor.result.output, JSON.stringify(runtimeResult)).not.toContain(SECRET);
      const limited = await runExecutor(outputTool(JSON.stringify(runtimeResult)));
      expect(limited.result.output, JSON.stringify(runtimeResult)).not.toContain(SECRET);
      expect(limited.parsed, JSON.stringify(runtimeResult)).not.toHaveProperty("sessionID");
    }
    // A secret-shaped sessionID is refused as an identity field, never rewritten.
    const onlySession = await runExecutor(outputTool(JSON.stringify({ generation: 1, status: "completed", isError: false, output: "safe", truncated: false, sessionID: SECRET })));
    expect(onlySession.parsed).toEqual({ isError: true, code: "child_failed", status: "failed", truncated: false, error: "" });
    for (const args of [{ ...CREATE, agent: SECRET }, { sessionID: SECRET, prompt: "x" }]) {
      const rec = recorder();
      const result = await rec.tool.execute(args, ctx);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.code).toBe("invalid_request");
      expect(result.output).not.toContain(SECRET);
      expect(rec.calls).toHaveLength(0);
    }
  });

  test("an unknown input key never reflects its name back to the caller", async () => {
    const computed: AnyRecord = { ...CREATE };
    computed[SECRET] = "value";
    const direct = await buildTool(async () => RUNNING).execute(computed, ctx);
    expect(direct.isError).toBe(true);
    expect(direct.code).toBe("invalid_request");
    expect(direct.output).not.toContain(SECRET);
    expect(parseEnvelope(direct.output).error).toBe("unknown field in this variant");
    const throughExecutor = await runExecutor(buildTool(async () => RUNNING), undefined, computed);
    expect(throughExecutor.result.output).not.toContain(SECRET);
    expect(throughExecutor.parsed.error).toBe("unknown field in this variant");
  });

  test("an ordinary failed outcome without identity fails closed even with a valid code", async () => {
    for (const isError of [false, undefined]) {
      const runtimeResult = { isError, code: "unknown_agent", status: "failed", error: `untrusted ${SECRET}`, truncated: false };
      const direct = await buildTool(async () => runtimeResult).execute(CREATE, ctx);
      expect(direct.code, String(isError)).toBe("child_failed");
      expect(parseEnvelope(direct.output), String(isError)).toEqual({ isError: true, code: "child_failed", status: "failed", truncated: false, error: "" });
      expect(direct.output, String(isError)).not.toContain(SECRET);
      const throughExecutor = await runExecutor(buildTool(async () => runtimeResult));
      expect(throughExecutor.parsed, String(isError)).toEqual({ isError: true, code: "child_failed", status: "failed", truncated: false, error: "" });
      expect(throughExecutor.result.output, String(isError)).not.toContain(SECRET);
    }
  });

  test("an ID-less accepted outcome, active failure or partial identity fails closed", async () => {
    for (const runtimeResult of [
      { sessionID: "s1", status: "running", isError: false },
      { generation: 1, status: "completed", isError: false, output: "", truncated: false },
      { isError: true, code: "foreground_timeout", status: "cancelling", error: `deadline ${SECRET}`, truncated: false },
      { sessionID: "s1", isError: true, code: "unknown_agent", status: "failed", error: "missing", truncated: false },
      { generation: 1, isError: false, status: "completed", output: "final", truncated: false },
    ]) {
      const result = await buildTool(async () => runtimeResult).execute(CREATE, ctx);
      expect(result.code, JSON.stringify(runtimeResult)).toBe("child_failed");
      expect(parseEnvelope(result.output), JSON.stringify(runtimeResult)).toEqual({ isError: true, code: "child_failed", status: "failed", truncated: false, error: "" });
      expect(result.output).not.toContain(SECRET);
    }
  });

  test("ordinary cancellation has no code and foreground_timeout keeps its stable code", async () => {
    const cancelled = await buildTool(async () => statusResult("cancelled")).execute(CREATE, ctx);
    expect(cancelled.isError).not.toBe(true);
    expect(cancelled.code).toBeUndefined();
    expect("code" in parseEnvelope(cancelled.output)).toBe(false);
    const timeout = await buildTool(async () => statusResult("cancelling", "foreground_timeout")).execute({ ...CREATE, background: false, timeoutMs: 5_000 }, ctx);
    expect(timeout.isError).toBe(true);
    expect(timeout.code).toBe("foreground_timeout");
    expect(parseEnvelope(timeout.output)).toMatchObject({ status: "cancelling", code: "foreground_timeout" });
  });

  test("every result is transient and keeps a bounded settled payload", async () => {
    for (const status of ["running", "completed", "failed"]) {
      const result = await buildTool(async () => statusResult(status)).execute(CREATE, ctx);
      expect(result.transient, status).toBe(true);
      const parsed = parseEnvelope(result.output);
      if (status !== "running") expect(parsed.truncated, status).toBe(false);
      if (status !== "running") expect(typeof (parsed.output ?? parsed.error), status).toBe("string");
    }
    const empty = await buildTool(async () => ({ sessionID: "s1", generation: 1, status: "completed", isError: false, output: "", truncated: false })).execute(CREATE, ctx);
    expect(parseEnvelope(empty.output)).toEqual({ sessionID: "s1", generation: 1, status: "completed", isError: false, truncated: false, output: "" });
    const cutOff = await buildTool(async () => ({ sessionID: "s1", generation: 1, status: "completed", isError: false, output: "final", truncated: true })).execute(CREATE, ctx);
    expect(parseEnvelope(cutOff.output)).toMatchObject({ status: "completed", truncated: true, output: "final" });
  });

  test("direct factory output is XML-safe and hides no code or secret", async () => {
    const result = await buildTool(async () => ({ sessionID: "s1", generation: 1, status: "failed", isError: true, error: `${SECRET} ${CLOSE_TAG}`, truncated: true })).execute(CREATE, ctx);
    expect(result.output).not.toContain(CLOSE_TAG);
    expect(result.output).not.toContain("<");
    expect(result.output).not.toContain(">");
    expect(result.output).not.toContain("&");
    expect(result.output).not.toContain(SECRET);
    expect(parseEnvelope(result.output).error).toContain("[REDACTED]");
    expect(parseEnvelope(result.output).error).toContain(CLOSE_TAG);
  });
});

describe("subagent safe envelope through the real ToolExecutor (#680)", () => {
  const envelope = (over: AnyRecord): string => JSON.stringify({ sessionID: "s1", generation: 1, status: "completed", isError: false, output: "", truncated: false, ...over });
  const cap = (base: string): number => estimateTokens(base) + 1;

  test("running reaches the parent transient, mapped and artifact-free", async () => {
    const run = await runExecutor(buildTool(async () => RUNNING), cap(envelope({ output: "" })));
    expect(run.result.transient).toBe(true);
    expect(run.result.isError).toBe(false);
    expect(run.result.code).toBeUndefined();
    expect(run.parsed).toMatchObject({ sessionID: "s1", generation: 1, status: "running", isError: false });
    expect(artifactFiles(run.cwd)).toEqual([]);
  });

  test("fixed envelope tokens + 1 keeps a settled success parseable, bounded and artifact-free", async () => {
    const base = envelope({ output: "" });
    const run = await runExecutor(buildTool(async () => ({ sessionID: "s1", generation: 1, status: "completed", isError: false, output: PAYLOAD, truncated: false })), cap(base));
    expect(run.parsed).toMatchObject({ sessionID: "s1", generation: 1, status: "completed", isError: false, truncated: true });
    expect(run.result.transient).toBe(true);
    expect(run.result.isError).toBe(false);
    expect(estimateTokens(run.result.output)).toBeLessThanOrEqual(cap(base));
    expect(run.result.output).not.toContain(SECRET);
    expect(run.result.output).not.toContain(CLOSE_TAG);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });

  test("a child_failed failure keeps isError and code after envelope truncation", async () => {
    const base = envelope({ status: "failed", isError: true, code: "child_failed", output: "", error: "" });
    const run = await runExecutor(buildTool(async () => ({ sessionID: "s1", generation: 1, status: "failed", isError: true, error: `provider outage ${SECRET} ${CLOSE_TAG}`, truncated: false })), cap(base));
    expect(run.parsed).toMatchObject({ sessionID: "s1", generation: 1, status: "failed", isError: true, code: "child_failed", truncated: true });
    expect(run.result.isError).toBe(true);
    expect(run.result.code).toBe("child_failed");
    expect(run.result.transient).toBe(true);
    expect(estimateTokens(run.result.output)).toBeLessThanOrEqual(cap(base));
    expect(run.result.output).not.toContain(SECRET);
    expect(run.result.output).not.toContain(CLOSE_TAG);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });

  test("a nested payload is bounded to 8 KiB without a session cap and without an artifact", async () => {
    const run = await runExecutor(outputTool(envelope({ output: PAYLOAD })));
    expect(run.parsed.status).toBe("completed");
    expect(run.parsed.truncated).toBe(true);
    expect(Buffer.byteLength(String(run.parsed.output), "utf8")).toBeLessThanOrEqual(SUBAGENT_LIMITS.payloadBytes);
    // The wrapper terminator survives only as decoded child data, never literally.
    expect(String(run.parsed.output)).toContain(CLOSE_TAG);
    expect(run.result.output).not.toContain(CLOSE_TAG);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });

  test("a cap below the minimum safe envelope still yields a valid bounded envelope", async () => {
    const run = await runExecutor(outputTool(envelope({ output: PAYLOAD })), 5);
    expect(run.parsed).toMatchObject({ sessionID: "s1", generation: 1, status: "completed", isError: false, truncated: true, output: "" });
    expect(run.result.output).not.toContain(SECRET);
    expect(artifactFiles(run.cwd)).toEqual([]);
  });

  test("escape-heavy output and error both honor a representable token cap", async () => {
    const heavy = `<&>\\".`.repeat(4_000);
    const base = envelope({ output: "", error: "" });
    const run = await runExecutor(outputTool(envelope({ output: heavy, error: heavy })), cap(base) + 20);
    expect(estimateTokens(run.result.output)).toBeLessThanOrEqual(cap(base) + 20);
    expect(run.parsed.truncated).toBe(true);
    // A settled result carries one bounded payload; the extra key is dropped.
    expect(typeof run.parsed.output).toBe("string");
    expect(run.parsed.error).toBeUndefined();
    expect(run.result.output).not.toContain(SECRET);
    expect(artifactFiles(run.cwd)).toEqual([]);
    const failed = envelope({ status: "failed", isError: true, code: "child_failed", output: "", error: "" });
    const failure = await runExecutor(outputTool(failed.replace('"error":""', `"error":"${heavy}"`)), cap(failed) + 20);
    expect(estimateTokens(failure.result.output)).toBeLessThanOrEqual(cap(failed) + 20);
    expect(failure.parsed.code).toBe("child_failed");
    expect(failure.parsed.truncated).toBe(true);
    expect(typeof failure.parsed.error).toBe("string");
    expect(artifactFiles(failure.cwd)).toEqual([]);
  });

  test("malformed, empty and non-envelope output fails closed without leaking the raw text", async () => {
    const oversized = `${SECRET} ${CLOSE_TAG} ${"x".repeat(20_000)}`;
    for (const output of ["{not json", "[]", "null", '"scalar"', "42", "", oversized]) {
      const run = await runExecutor(outputTool(output), 20);
      expect(run.parsed, output.slice(0, 12)).toMatchObject({ isError: true, code: "child_failed", status: "failed", truncated: false });
      expect(run.result.isError).toBe(true);
      expect(run.result.code).toBe("child_failed");
      expect(run.result.transient).toBe(true);
      expect(run.result.output).not.toContain(SECRET);
      expect(run.result.output).not.toContain(CLOSE_TAG);
      expect(run.result.output.length).toBeLessThan(300);
      expect(artifactFiles(run.cwd)).toEqual([]);
    }
  });

  test("unknown and malformed fixed fields are dropped or fail closed", async () => {
    const unknown = await runExecutor(outputTool(envelope({ extra: `${SECRET} ${CLOSE_TAG}`, tag: "x".repeat(20_000) })));
    expect(unknown.parsed.extra).toBeUndefined();
    expect(unknown.result.output).not.toContain(SECRET);
    for (const broken of [{ status: "starting" }, { status: "completed", sessionID: "" }, { status: "completed", generation: 0 }, { status: "completed", isError: "yes" }, { status: "completed", code: "not_a_code" }]) {
      const run = await runExecutor(outputTool(envelope(broken)));
      expect(run.parsed, JSON.stringify(broken)).toMatchObject({ isError: true, code: "child_failed", status: "failed" });
      expect(run.parsed).not.toHaveProperty("sessionID");
    }
  });

  test("UTF-8 payloads at the 8 KiB boundary never split a sequence", async () => {
    for (const size of [SUBAGENT_LIMITS.payloadBytes - 1, SUBAGENT_LIMITS.payloadBytes, SUBAGENT_LIMITS.payloadBytes + 1]) {
      const text = utf8Bytes(size);
      expect(Buffer.byteLength(text, "utf8")).toBe(size);
      const run = await runExecutor(outputTool(envelope({ output: text })));
      const output = String(run.parsed.output);
      expect(Buffer.byteLength(output, "utf8"), `size ${size}`).toBeLessThanOrEqual(SUBAGENT_LIMITS.payloadBytes);
      expect(output, `size ${size}`).not.toContain("\uFFFD");
      expect(run.parsed.truncated, `size ${size}`).toBe(size > SUBAGENT_LIMITS.payloadBytes);
      const tight = await runExecutor(outputTool(envelope({ output: text })), 40);
      expect(estimateTokens(tight.result.output), `tight ${size}`).toBeLessThanOrEqual(40);
      expect(tight.parsed.truncated, `tight ${size}`).toBe(true);
    }
  });

  test("the generic limiter still rewrites tools other than subagent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-subagent-other-"));
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const result = await new ToolExecutor({ tools: [outputTool("z".repeat(40_000), "other")], allow: ["other"], audit, permissionMode: "bypass", permission: "execute" })
      .run({ cwd, run: "r1", agent: "plan", permission: "execute", outputLimitTokens: 50 }, { id: "c1", name: "other", arguments: "{}" });
    expect(result.output).toContain("[saída truncada");
    expect(artifactFiles(cwd)).not.toEqual([]);
  });
});