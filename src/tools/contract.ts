/**
 * Tool output contract (S6, #603): one taxonomy, one declared ceiling and one
 * marker, reusing `redactSecrets` (I-03) and the session cap (CMP-10).
 */
import type { ToolContext, ToolFailure, ToolOutputCeiling, ToolResult, TruncationInfo } from "./types";
import { ToolDeniedError, ToolError } from "./types";

/** Closed taxonomy; a tool never invents a fifth code. */
export const TOOL_FAILURES: readonly ToolFailure[] = ["denied", "failed", "timeout", "invalid"];

/** Runtime guard for plugin manifests and legacy results. */
export function isToolFailure(value: unknown): value is ToolFailure {
  return typeof value === "string" && (TOOL_FAILURES as readonly string[]).includes(value);
}

/** Taxonomy code of a thrown error: a typed denial wins over the generic class (S6, #603). */
export function failureCodeOf(error: unknown): ToolFailure {
  if (error instanceof ToolDeniedError) return "denied";
  return error instanceof ToolError ? "invalid" : "failed";
}

/** Failure result for a thrown error, classified by cause. */
export function failureFrom(error: unknown): ToolResult {
  return failureResult(error instanceof Error ? error.message : String(error), failureCodeOf(error));
}

/** Failure result: taxonomy code always, policy `code` only when the caller has one. */
export function failureResult(message: string, failure: ToolFailure, code?: string): ToolResult {
  return { output: message, isError: true, failure, ...(code === undefined ? {} : { code }) };
}

/** Reserved characters for the marker inside the declared ceiling. */
export const MARKER_RESERVE_CHARS = 300;

/**
 * Characters a tool may emit: its declared token ceiling (`~4 chars/token`),
 * lowered by the session cap. `undefined` means the tool declares no ceiling.
 */
export function outputCeilingChars(ceiling: ToolOutputCeiling | undefined, ctx?: Pick<ToolContext, "outputLimitTokens">): number | undefined {
  if (ceiling === undefined) return undefined;
  return Math.max(64, Math.min(ceiling.maxTokens, ctx?.outputLimitTokens ?? ceiling.maxTokens) * 4);
}

/** Characters available to the content once the marker reserve is taken out. */
export function contentBudgetChars(ceiling: ToolOutputCeiling, ctx?: Pick<ToolContext, "outputLimitTokens">): number {
  return Math.max(64, (outputCeilingChars(ceiling, ctx) ?? ceiling.maxTokens * 4) - MARKER_RESERVE_CHARS);
}

/** Marker text plus the same data as a structured field. */
export function truncationReport(report: TruncationInfo): { field: TruncationInfo; marker: string } {
  return {
    field: { ...report },
    marker: `[output truncated: ${report.removed} of ${report.total} ${report.unit} omitted; ${report.hint}]`,
  };
}
