/**
 * Concurrency bound (ADR-0037): the model asks, the harness grants. The bound
 * is resolved once per run; ADR-0037 owns the per-account capacity that consumes
 * it. An explicit declaration wins over `/config`, which wins over two.
 */
import type { AstroConfig } from "./core/config";

export const DEFAULT_MAX_CONCURRENT_PER_PROVIDER = 2;

export type ConcurrencySource = "request" | "config" | "default";

export interface ConcurrencyCap {
  cap: number;
  source: ConcurrencySource;
}

export interface ConcurrencyGrant {
  requested: number;
  granted: number;
  cap: number;
  source: ConcurrencySource;
  truncated: boolean;
  /** Always set: why the harness granted this number. */
  reason: string;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** explicit request > `spawn.maxConcurrent` > 2; invalid values never widen the bound. */
export function resolveConcurrencyCap(source: { request?: number; config?: number }): ConcurrencyCap {
  const request = positiveInteger(source.request);
  if (request !== undefined) return { cap: request, source: "request" };
  const config = positiveInteger(source.config);
  if (config !== undefined) return { cap: config, source: "config" };
  return { cap: DEFAULT_MAX_CONCURRENT_PER_PROVIDER, source: "default" };
}

/** Cap for one spawn: `agents.maxActive` is the explicit tier, `spawn.maxConcurrent` the config tier. */
export function spawnConcurrencyCap(config: AstroConfig): ConcurrencyCap {
  return resolveConcurrencyCap({
    ...(config.maxActive === undefined ? {} : { request: config.maxActive }),
    ...(config.spawn?.maxConcurrent === undefined ? {} : { config: config.spawn.maxConcurrent }),
  });
}

/** Truncate the request at the cap and state the cut, so the model does not ask again blindly. */
export function grantConcurrency(requested: number | undefined, cap: ConcurrencyCap): ConcurrencyGrant {
  const asked = positiveInteger(requested) ?? 1;
  const granted = Math.min(asked, cap.cap);
  return {
    requested: asked,
    granted,
    cap: cap.cap,
    source: cap.source,
    truncated: granted < asked,
    reason: granted < asked
      ? `requested ${asked}, granted ${granted}: ${cap.source} cap`
      : `within ${cap.source} cap`,
  };
}
