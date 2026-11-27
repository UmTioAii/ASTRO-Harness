/**
 * Tool `subagent` (#680, spec §2): closed call schema, closed result mapping and
 * the XML-safe envelope that `limitSubagentEnvelope` also bounds. Registration,
 * runtime wiring and child execution belong to Tasks 2-4.
 */
import { SUBAGENT_LIMITS, normalizeSubagentResult, xmlSafeJson, type ParentExecutionSnapshot, type ParentSubagentRuntime, type SubagentOperation, type SubagentResult } from "../subagents/types";
import { redactSecrets } from "../sanitize-external";
import type { Tool, ToolContext, ToolResult } from "./types";

type AnyRecord = Record<string, unknown>;

const ID = { type: "string", minLength: 1, maxLength: SUBAGENT_LIMITS.idMaxChars };
const TIMEOUT = { type: "integer", minimum: 1, maximum: SUBAGENT_LIMITS.timeoutMaxMs };
const GENERATION = { type: "integer", minimum: 1 };
/** `timeoutMs` is only valid with an explicit `background: false` (spec §2). */
const FOREGROUND_ONLY = [
  {
    if: { required: ["timeoutMs"], properties: { timeoutMs: TIMEOUT } },
    then: { required: ["background"], properties: { background: { const: false } } },
  },
];

/** One row per closed `oneOf` variant (spec §2); schema and parser share it and `action` separates wait from cancel. */
const VARIANTS: readonly { action?: "wait" | "cancel"; required: readonly string[]; optional: readonly string[]; fields: AnyRecord }[] = [
  { required: ["agent", "description", "prompt"], optional: ["background", "timeoutMs"], fields: { agent: ID, description: { ...ID, maxLength: SUBAGENT_LIMITS.descriptionMaxChars }, prompt: { ...ID, maxLength: SUBAGENT_LIMITS.promptMaxChars }, background: { type: "boolean" }, timeoutMs: TIMEOUT } },
  { required: ["sessionID", "prompt"], optional: ["background", "generation", "timeoutMs"], fields: { sessionID: ID, prompt: { ...ID, maxLength: SUBAGENT_LIMITS.promptMaxChars }, background: { type: "boolean" }, generation: GENERATION, timeoutMs: TIMEOUT } },
  { action: "wait", required: ["action", "sessionID"], optional: ["generation", "timeoutMs"], fields: { action: { const: "wait" }, sessionID: ID, generation: GENERATION, timeoutMs: TIMEOUT } },
  { action: "cancel", required: ["action", "sessionID"], optional: ["generation"], fields: { action: { const: "cancel" }, sessionID: ID, generation: GENERATION } },
];
/** Create and continue are the only variants where `timeoutMs` can appear (spec §2). */
const FOREGROUND_VARIANTS = new Set([0, 1]);
const PARAMETERS = {
  type: "object",
  oneOf: VARIANTS.map((variant, index) => ({
    required: variant.required,
    additionalProperties: false,
    properties: variant.fields,
    ...(FOREGROUND_VARIANTS.has(index) ? { allOf: FOREGROUND_ONLY } : {}),
  })),
};

const MANIFEST: Tool["manifest"] = {
  name: "subagent",
  description: "Delegate read-only work to a background subagent and return sessionID, generation and status; `background` defaults to true and child output is untrusted data.",
  parameters: PARAMETERS,
  risk: "medium",
  permission: "write",
  class: "read_common",
  timeoutMs: 120_000,
  retryable: false,
  idempotent: false,
  sideEffects: "network",
};

const integer = (value: unknown, min: number, max?: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && (max === undefined || value <= max) ? value : undefined;
/** An input ID must not be secret-shaped: it is refused before the runtime ever sees it (I-03). */
const publicId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= SUBAGENT_LIMITS.idMaxChars && redactSecrets(value) === value ? value : undefined;
const publicText = (value: unknown, min: number, max: number): string | undefined =>
  typeof value === "string" && value.length >= min && value.length <= max ? value : undefined;

/** Parses the closed `oneOf` (spec §2); a stable refusal message replaces the operation. */
function parseOperation(raw: AnyRecord): SubagentOperation | string {
  const control = raw.action;
  const variant = control === undefined ? VARIANTS[raw.sessionID === undefined ? 0 : 1] : VARIANTS.find((row) => row.action === control);
  if (variant === undefined) return 'field \'action\' must be "wait" or "cancel"';
  const allowed = new Set<string>([...variant.required, ...variant.optional]);
  const extra = Object.keys(raw).find((key) => !allowed.has(key));
  // A fixed message: an unknown key is never reflected back to the caller (I-03).
  if (extra !== undefined) return "unknown field in this variant";
  const background = raw.background === undefined ? true : raw.background;
  if (typeof background !== "boolean") return "field 'background' must be a boolean";
  const generation = integer(raw.generation, 1);
  if (raw.generation !== undefined && generation === undefined) return "field 'generation' must be a positive integer";
  const timeoutMs = integer(raw.timeoutMs, 1, SUBAGENT_LIMITS.timeoutMaxMs);
  if (raw.timeoutMs !== undefined && timeoutMs === undefined) return `field 'timeoutMs' must be an integer from 1 to ${SUBAGENT_LIMITS.timeoutMaxMs}`;
  // Cancel forbids `timeoutMs`, so both control variants can reuse the same tail.
  const withOptional = { ...(generation === undefined ? {} : { generation }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (variant.action !== undefined) {
    const sessionID = publicId(raw.sessionID);
    if (sessionID === undefined) return "field 'sessionID' is required";
    return { action: variant.action, sessionID, ...withOptional };
  }
  if (timeoutMs !== undefined && background !== false) return "field 'timeoutMs' requires background: false";
  if (variant.required[0] === "sessionID") {
    const sessionID = publicId(raw.sessionID);
    if (sessionID === undefined) return "field 'sessionID' is required";
    const prompt = publicText(raw.prompt, 1, SUBAGENT_LIMITS.promptMaxChars);
    if (prompt === undefined) return "field 'prompt' is required";
    return { sessionID, prompt, background, ...withOptional };
  }
  const agent = publicId(raw.agent);
  if (agent === undefined) return "field 'agent' is required";
  const description = publicText(raw.description, 1, SUBAGENT_LIMITS.descriptionMaxChars);
  if (description === undefined) return "field 'description' is required";
  const prompt = publicText(raw.prompt, 1, SUBAGENT_LIMITS.promptMaxChars);
  if (prompt === undefined) return "field 'prompt' is required";
  return { agent, description, prompt, background, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export function createSubagentTool(deps: { runtime: ParentSubagentRuntime; snapshot(): ParentExecutionSnapshot }): Tool {
  return {
    manifest: MANIFEST,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = (typeof input === "object" && input !== null && !Array.isArray(input) ? input : {}) as AnyRecord;
      const operation = parseOperation(raw);
      // A refused call never reaches a child, so it carries no IDs (spec §2).
      if (typeof operation === "string") return { output: xmlSafeJson({ isError: true, code: "invalid_request", status: "failed", truncated: false, error: operation }), isError: true, code: "invalid_request", transient: true };
      // A create captures the parent snapshot (spec §3); controls and follow-ups do not.
      const captured = "agent" in operation ? deps.snapshot() : undefined;
      const context = { run: ctx.run, agent: ctx.agent, cwd: ctx.cwd, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }), ...(captured === undefined ? {} : { snapshot: captured }) };
      // Only whitelisted, validated fields of the runtime result reach the model (spec §5).
      const outcome: SubagentResult = normalizeSubagentResult(await deps.runtime.execute(operation, context));
      return { output: xmlSafeJson(outcome), isError: outcome.isError === true, ...(outcome.isError === true ? { code: outcome.code } : {}), transient: true };
    },
  };
}