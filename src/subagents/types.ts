/**
 * Public contracts of the background `subagent` tool (#680, spec §2): closed
 * types, closed limits, validation of a runtime result and the XML-safe
 * serialization shared by the tool and the envelope limiter.
 */
import { redactSecrets } from "../sanitize-external";
/** Closed stable error codes (spec §2). */
export type SubagentErrorCode =
  | "invalid_request" | "unknown_agent" | "session_missing" | "ownership_denied" | "generation_stale"
  | "child_failed" | "child_settling" | "child_queue_full" | "spawn_limit_exceeded" | "account_locked"
  | "children_active" | "foreground_timeout" | "close_timeout";

/** Public statuses (spec §2); admission's `starting` is internal and never returned. */
export type SubagentStatus =
  | "running" | "waiting" | "cancelling" | "settling" | "completed" | "failed" | "cancelled" | "paused";

/** Closed control actions of the tool call. */
export type SubagentAction = "wait" | "cancel";

/** Settled outcomes (spec §2); they carry bounded `output`/`error` plus `truncated`. */
export const SETTLED_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "paused"]);
/** Active outcomes: the parent turn has no final result yet. */
export const ACTIVE_STATUSES: readonly string[] = ["running", "waiting", "cancelling", "settling"];

/** Closed `oneOf` payload (spec §2): `background` defaults to true, a control operation never acquires it and `timeoutMs` requires `background: false`. */
export type SubagentOperation =
  | { action?: undefined; agent: string; description: string; prompt: string; background: boolean; timeoutMs?: number }
  | { action?: undefined; sessionID: string; prompt: string; background: boolean; generation?: number; timeoutMs?: number }
  | { action: "wait"; sessionID: string; background?: undefined; generation?: number; timeoutMs?: number }
  | { action: "cancel"; sessionID: string; background?: undefined; generation?: number };

/** Parent scope handed to the runtime with every operation. */
export interface SubagentCallContext {
  run: string;
  agent: string;
  cwd: string;
  signal?: AbortSignal;
  /** Snapshot captured at create (spec §3); controls and follow-ups carry none. */
  snapshot?: ParentExecutionSnapshot;
}

/** Immutable parent state captured at create; a later generation never follows a reload. */
export interface ParentExecutionSnapshot {
  run: string;
  agent: string;
  cwd: string;
  allow?: readonly string[];
  permission?: string;
  maxSteps?: number;
}

/**
 * Closed success/failure union (spec §2).
 *
 * Accepted outcomes require real IDs and generation; settled ones also require
 * `truncated` and exactly one bounded payload. A failure always carries a closed
 * code: active failures (such as `foreground_timeout` on `cancelling`) and
 * settled failures carry the identity plus `error`, while a well-formed refusal
 * before any child identity exists carries neither ID field. `failed` is never
 * non-error: an ordinary child failure is `isError: true` with `child_failed`.
 */
/** Identity plus stable code every identified failure shares. */
interface SubagentIdentifiedFailure {
  isError: true;
  code: SubagentErrorCode;
  sessionID: string;
  generation: number;
  truncated: boolean;
}
/** Settled outcomes carry exactly one bounded payload. */
type SettledStatuses = "completed" | "failed" | "cancelled" | "paused";

export type SubagentResult =
  | {
      isError: false;
      code?: never;
      sessionID: string;
      generation: number;
      status: "running" | "waiting" | "cancelling" | "settling";
      output?: never;
      error?: never;
      truncated?: never;
    }
  | {
      isError: false;
      code?: never;
      sessionID: string;
      generation: number;
      status: "completed" | "cancelled" | "paused";
      truncated: boolean;
      output: string;
      error?: never;
    }
  | {
      isError: false;
      code?: never;
      sessionID: string;
      generation: number;
      status: "completed" | "cancelled" | "paused";
      truncated: boolean;
      error: string;
      output?: never;
    }
  | SubagentIdentifiedFailure & { status: "running" | "waiting" | "cancelling" | "settling"; error: string; output?: never }
  | SubagentIdentifiedFailure & { status: SettledStatuses; output: string; error?: never }
  | SubagentIdentifiedFailure & { status: SettledStatuses; error: string; output?: never }
  | {
      isError: true;
      code: SubagentErrorCode;
      sessionID?: never;
      generation?: never;
      status: "failed";
      truncated: boolean;
      output?: never;
      error: string;
    };

/** The only runtime surface the tool consumes; Tasks 2-4 own the implementation. */
export interface ParentSubagentRuntime {
  execute(operation: SubagentOperation, context: SubagentCallContext): Promise<SubagentResult>;
}

/** Spec §2/§5 limits shared by the tool and the envelope limiter. */
export const SUBAGENT_LIMITS = {
  idMaxChars: 64,
  descriptionMaxChars: 160,
  promptMaxChars: 32_000,
  timeoutMaxMs: 110_000,
  payloadBytes: 8_192,
} as const;

// ---------------------------------------------------------------------------
// Runtime result validation and safe serialization (spec §2/§5)
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

const STATUS_SET: ReadonlySet<string> = new Set<string>([...ACTIVE_STATUSES, ...SETTLED_STATUSES]);
const CODE_SET: ReadonlySet<string> = new Set<string>([
  "invalid_request", "unknown_agent", "session_missing", "ownership_denied", "generation_stale",
  "child_failed", "child_settling", "child_queue_full", "spawn_limit_exceeded", "account_locked",
  "children_active", "foreground_timeout", "close_timeout",
]);

const closedCode = (value: unknown): SubagentErrorCode | undefined =>
  typeof value === "string" && CODE_SET.has(value) ? (value as SubagentErrorCode) : undefined;
const closedStatus = (value: unknown): SubagentStatus | undefined =>
  typeof value === "string" && STATUS_SET.has(value) ? (value as SubagentStatus) : undefined;
/** A public ID must not be secret-shaped: a rewritten identity is never emitted (I-03). */
const publicId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= SUBAGENT_LIMITS.idMaxChars && redactSecrets(value) === value ? value : undefined;
const publicGeneration = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;

/** Minimal stable failure envelope used whenever a result cannot be trusted. */
const safeFailure = (): SubagentResult => ({
  isError: true,
  code: "child_failed",
  status: "failed",
  truncated: false,
  error: "",
});

/**
 * Rebuilds the closed public result from validated fields only (spec §2/§5):
 * unknown fields are dropped instead of spread, malformed fixed fields and a
 * missing identity fail closed, and an ordinary `status: "failed"` outcome is
 * always `isError: true` with a stable code. IDs are never fabricated.
 */
export function normalizeSubagentResult(raw: unknown): SubagentResult {
  const value: AnyRecord = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as AnyRecord) : {};
  const status = closedStatus(value.status);
  const isError = typeof value.isError === "boolean" ? value.isError : undefined;
  const truncated = typeof value.truncated === "boolean" ? value.truncated : undefined;
  const output = typeof value.output === "string" ? value.output : undefined;
  const error = typeof value.error === "string" ? value.error : undefined;
  const code = value.code === undefined ? undefined : closedCode(value.code);
  // A malformed status, discriminator, flag, payload or code is not a result (spec §5).
  if (status === undefined || (value.isError !== undefined && isError === undefined)
    || (value.truncated !== undefined && truncated === undefined) || (value.output !== undefined && output === undefined)
    || (value.error !== undefined && error === undefined) || (value.code !== undefined && code === undefined)) return safeFailure();
  const sessionID = publicId(value.sessionID);
  const generation = publicGeneration(value.generation);
  // A partial or malformed identity never becomes an accepted result.
  if ((value.sessionID !== undefined && sessionID === undefined) || (value.generation !== undefined && generation === undefined)) return safeFailure();
  // Child text is untrusted data: no secret ever reaches the parent context (I-03).
  const clean = (text: string | undefined): string | undefined => (text === undefined ? undefined : redactSecrets(text));
  // An ordinary execution failure is an error with a stable code, whatever the discriminator said.
  if (isError === true || status === "failed") {
    const failure = { code: code ?? "child_failed", truncated: truncated ?? false, error: clean(error) ?? clean(output) ?? "" };
    // Only an explicit failure without any child identity may keep its stable code (spec §2).
    if (status === "failed" && isError === true && sessionID === undefined && generation === undefined) return { isError: true, status, ...failure };
    // Anything else — including a `cancelling` foreground timeout — needs both IDs.
    if (sessionID === undefined || generation === undefined) return safeFailure();
    if (status === "running" || status === "waiting" || status === "cancelling" || status === "settling") return { isError: true, sessionID, generation, status, ...failure };
    return { isError: true, sessionID, generation, status, ...failure };
  }
  // Accepted outcomes require both real IDs and generation; they are never fabricated.
  if (sessionID === undefined || generation === undefined) return safeFailure();
  if (status === "running" || status === "waiting" || status === "cancelling" || status === "settling") {
    return { isError: false, sessionID, generation, status };
  }
  // Settled outcomes keep `truncated` plus a bounded payload, even when empty.
  return output === undefined
    ? { isError: false, sessionID, generation, status, truncated: truncated ?? false, error: clean(error) ?? "" }
    : { isError: false, sessionID, generation, status, truncated: truncated ?? false, output: clean(output) as string };
}

/** JSON with `<`, `>` and `&` Unicode-escaped, so no wrapper tag can survive while decoding recovers the text. */
export function xmlSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (char) => `\\u00${char.codePointAt(0)!.toString(16).padStart(2, "0")}`);
}