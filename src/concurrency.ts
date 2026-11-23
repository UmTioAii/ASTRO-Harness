/**
 * Concurrency bound per provider (ADR-0037): the model asks, the harness grants.
 * An explicit user declaration wins over `/config`, which wins over the default
 * of two. Concurrency is counted per provider; credentials are shared up to it.
 */
import type { AstroConfig } from "./core/config";
import { activeLocks, DEFAULT_MAX_PER_ACCOUNT, type AgentLock } from "./agent-lock";
import type { Ledger } from "./ledger";

export const DEFAULT_MAX_CONCURRENT_PER_PROVIDER = DEFAULT_MAX_PER_ACCOUNT;

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

/** Active executions per provider; the scheduler and `astro locks` read the same count. */
export function activeByProvider(ledger: Ledger): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lock of activeLocks(ledger)) {
    if (lock.provider === undefined) continue;
    counts.set(lock.provider, (counts.get(lock.provider) ?? 0) + 1);
  }
  return counts;
}

/** Active executions per account, for capacity checks that keep the credential a shared resource. */
export function countByAccount(locks: readonly AgentLock[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lock of locks) counts.set(lock.accountRef, (counts.get(lock.accountRef) ?? 0) + 1);
  return counts;
}
