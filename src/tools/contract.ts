/**
 * Tool output contract (S6, #603): one taxonomy, one declared ceiling and one
 * marker, reusing `redactSecrets` (I-03) and the session cap (CMP-10).
 */
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

/** Reserved characters for the marker inside the declared ceiling. */
export const MARKER_RESERVE_CHARS = 300;

/**
 * Characters a tool may emit: its declared token ceiling (`~4 chars/token`),
 * lowered by the session cap, minus the marker reserve.
 */
export function contentBudgetChars(ceiling: ToolOutputCeiling, ctx?: Pick<ToolContext, "outputLimitTokens">): number {
  const tokens = Math.min(ceiling.maxTokens, ctx?.outputLimitTokens ?? ceiling.maxTokens);
  return Math.max(64, tokens * 4 - MARKER_RESERVE_CHARS);
}

/** Marker text plus the same data as a structured field. */
export function truncationReport(report: TruncationInfo): { field: TruncationInfo; marker: string } {
  return {
    field: { ...report },
    marker: `[output truncated: ${report.removed} of ${report.total} ${report.unit} omitted; ${report.hint}]`,
  };
}
