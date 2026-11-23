/**
 * Tool output contract (S6, #603): one failure taxonomy, one declared ceiling
 * and one truncation marker for every tool.
 *
 * Reuses the existing primitives instead of a second policy engine:
 * `redactSecrets` (I-03) runs at the source, before any cut, and the session cap
 * `ctx.outputLimitTokens` (CMP-10) lowers a declared ceiling, never raises it.
 */
import { DEFAULT_OUTPUT_LIMIT } from "../output-limit";
import type { ToolContext, ToolFailure, ToolOutputCeiling, ToolResult, TruncationInfo } from "./types";

/** Closed taxonomy; a tool never invents a fifth code. */
export const TOOL_FAILURES: readonly ToolFailure[] = ["denied", "failed", "timeout", "invalid"];

/** Runtime guard for plugin manifests and legacy results. */
export function isToolFailure(value: unknown): value is ToolFailure {
  return typeof value === "string" && (TOOL_FAILURES as readonly string[]).includes(value);
}

/** Failure result: taxonomy code always, policy `code` only when the caller has one. */
export function failureResult(message: string, failure: ToolFailure, code?: string): ToolResult {
  return { output: message, isError: true, failure, ...(code === undefined ? {} : { code }) };
}

/** What a truncation removed, and how the model asks for the rest. */
export interface TruncationReport {
  removed: number;
  total: number;
  /** What the numbers count: `entries`, `results`, `lines`. */
  unit: string;
  hint: string;
}

/**
 * Characters the tool may emit: its declared ceiling, lowered by the session
 * token cap. `undefined` means the tool declares no ceiling.
 */
export function outputCeilingChars(
  ceiling: ToolOutputCeiling | undefined,
  ctx?: Pick<ToolContext, "outputLimitTokens">,
): number | undefined {
  if (ceiling === undefined) return undefined;
  const tokens = Math.min(ceiling.maxTokens, ctx?.outputLimitTokens ?? ceiling.maxTokens);
  return Math.max(64, tokens * 4);
}

/** Budget for the content when the marker is part of the same ceiling. */
export function contentBudgetChars(ceiling: ToolOutputCeiling, ctx?: Pick<ToolContext, "outputLimitTokens">): number {
  const chars = outputCeilingChars(ceiling, ctx) ?? DEFAULT_OUTPUT_LIMIT.maxTokens * 4;
  // The marker and envelope are additive to the budget but stay inside it.
  return Math.max(64, chars - MARKER_RESERVE_CHARS);
}

/** Reserved characters for the notice/marker inside the declared ceiling. */
export const MARKER_RESERVE_CHARS = 300;

/**
 * Marker shown to the model plus the same data as a structured field. JSON
 * envelopes carry `field` inside the object so parsing never breaks.
 */
export function truncationReport(report: TruncationReport): { field: TruncationInfo; marker: string } {
  return {
    field: { ...report },
    marker: `[output truncated: ${report.removed} of ${report.total} ${report.unit} omitted; ${report.hint}]`,
  };
}
