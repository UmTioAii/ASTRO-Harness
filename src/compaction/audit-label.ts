import { ProviderError } from "../providers/types";

/**
 * Stable audit label for a compaction failure: the D-18 class when the provider
 * classified it, `unclassified` otherwise. One owner, so the inline and the
 * background paths never drift apart.
 */
export function auditLabel(error: unknown): string {
  return error instanceof ProviderError ? error.errClass : "unclassified";
}
