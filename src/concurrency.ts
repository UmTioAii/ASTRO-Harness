/**
 * Concurrency bound per account (ADR-0037): the model asks, the harness grants.
 * An explicit user declaration wins over `/config`, which wins over the default
 * of two. The account (credentialRef) is the unit shared by model choice, lock
 * acquisition and `astro locks`, so a shared credential is never miscounted.
 */
import type { AstroConfig } from "./core/config";
import { MAX_ACTIVE_AGENTS } from "./core/config";
import { activeLocks, DEFAULT_MAX_PER_ACCOUNT } from "./agent-lock";
import type { Ledger } from "./ledger";

export const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = DEFAULT_MAX_PER_ACCOUNT;

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
  return { cap: DEFAULT_MAX_CONCURRENT_PER_ACCOUNT, source: "default" };
}

/** Cap for one spawn: `agents.maxActive` is the explicit tier, `spawn.maxConcurrent` the config tier. */
export function spawnConcurrencyCap(config: AstroConfig): ConcurrencyCap {
  const resolved = resolveConcurrencyCap({
    ...(config.maxActive === undefined ? {} : { request: config.maxActive }),
    ...(config.spawn?.maxConcurrent === undefined ? {} : { config: config.spawn.maxConcurrent }),
  });
  // The resolver is the single source of truth for #632 too: a stale or
  // hand-written config cannot widen a shared credential past the physical cap.
  return resolved.cap <= MAX_ACTIVE_AGENTS ? resolved : { ...resolved, cap: MAX_ACTIVE_AGENTS };
}

/** Truncate the request at the cap and state the cut, so the model does not ask again blindly. */
export function grantConcurrency(
  requested: number | undefined,
  cap: ConcurrencyCap,
  ceiling?: number,
): ConcurrencyGrant {
  const asked = positiveInteger(requested) ?? 1;
  const executable = ceiling === undefined ? cap.cap : Math.min(cap.cap, Math.max(1, Math.floor(ceiling)));
  const granted = Math.min(asked, executable);
  const ceilingLimited = ceiling !== undefined && ceiling < cap.cap && granted < asked;
  return {
    requested: asked,
    granted,
    cap: cap.cap,
    source: cap.source,
    truncated: granted < asked,
    reason: ceilingLimited
      ? `requested ${asked}, granted ${granted}: account ceiling (${cap.source} cap ${cap.cap})`
      : granted < asked
        ? `requested ${asked}, granted ${granted}: ${cap.source} cap`
        : `within ${cap.source} cap`,
  };
}

/** Active executions per account; the scheduler and `astro locks` read the same count. */
export function activeByAccount(ledger: Ledger): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lock of activeLocks(ledger)) counts.set(lock.accountRef, (counts.get(lock.accountRef) ?? 0) + 1);
  return counts;
}
