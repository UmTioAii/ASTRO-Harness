import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, RETRYABLE_CLASSES, errorPolicy, maxRetriesFor } from "../src/providers/policy";
import { FallbackProvider } from "../src/providers/fallback-provider";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type ErrorClass,
  type Provider,
} from "../src/providers/types";

const ALL_CLASSES: ErrorClass[] = [
  "transient_rate_limit",
  "hard_quota",
  "auth",
  "outage",
  "network_timeout",
  "invalid_request",
];

const req: CompletionRequest = { model: "m", messages: [{ role: "user", content: "oi" }] };
const ok: CompletionResponse = { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };

function failing(errClass: ErrorClass, counter: { calls: number }): Provider {
  return {
    complete() {
      counter.calls += 1;
      return Promise.reject(new ProviderError(errClass, "falha classificada"));
    },
  };
}

describe("retry matrix (D-18, #556)", () => {
  test("hard_quota never retries: skip from the first attempt", () => {
    expect(errorPolicy("hard_quota", 0)).toBe("skip");
    expect(errorPolicy("hard_quota", 1)).toBe("skip");
    expect(errorPolicy("hard_quota", 100)).toBe("skip");
    expect(maxRetriesFor("hard_quota")).toBe(0);
  });

  test("auth and invalid_request never retry: abort", () => {
    for (const c of ["auth", "invalid_request"] as const) {
      expect(errorPolicy(c, 0)).toBe("abort");
      expect(errorPolicy(c, 1)).toBe("abort");
      expect(maxRetriesFor(c)).toBe(0);
    }
  });

  test("transient_rate_limit retries with retry_after up to the limit, then fallback", () => {
    expect(maxRetriesFor("transient_rate_limit")).toBe(DEFAULT_LIMITS.maxRateLimitRetries);
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxRateLimitRetries; attempt++) {
      expect(errorPolicy("transient_rate_limit", attempt)).toBe("retry_after");
    }
    expect(errorPolicy("transient_rate_limit", DEFAULT_LIMITS.maxRateLimitRetries)).toBe("fallback");
  });

  test("outage and network_timeout retry with backoff up to the limit, then fallback", () => {
    for (const c of ["outage", "network_timeout"] as const) {
      expect(maxRetriesFor(c)).toBe(DEFAULT_LIMITS.maxOutageRetries);
      for (let attempt = 0; attempt < DEFAULT_LIMITS.maxOutageRetries; attempt++) {
        expect(errorPolicy(c, attempt)).toBe("retry_backoff");
      }
      expect(errorPolicy(c, DEFAULT_LIMITS.maxOutageRetries)).toBe("fallback");
    }
  });

  test("RETRYABLE_CLASSES is the single source for transient classes", () => {
    expect([...RETRYABLE_CLASSES].sort()).toEqual(["network_timeout", "outage", "transient_rate_limit"]);
    for (const c of ALL_CLASSES) {
      expect(RETRYABLE_CLASSES.has(c)).toBe(maxRetriesFor(c) > 0);
    }
  });

  test("every one of the six D-18 classes has a decision at attempt 0", () => {
    for (const c of ALL_CLASSES) {
      expect(["retry_backoff", "retry_after", "skip", "fallback", "abort"]).toContain(errorPolicy(c, 0));
    }
  });

  test("custom limits change the retry cap per class", () => {
    expect(maxRetriesFor("transient_rate_limit", { maxRateLimitRetries: 2 })).toBe(2);
    expect(maxRetriesFor("network_timeout", { maxOutageRetries: 1 })).toBe(1);
    expect(maxRetriesFor("hard_quota", { maxRateLimitRetries: 9, maxOutageRetries: 9 })).toBe(0);
  });
});

describe("FallbackProvider honors the matrix (#556)", () => {
  function chain(errClass: ErrorClass) {
    const primary = { calls: 0 };
    const backup = { calls: 0 };
    const provider = new FallbackProvider({
      providers: [
        { name: "primary", priority: 1, create: () => failing(errClass, primary) },
        {
          name: "backup",
          priority: 2,
          create: () => ({
            complete() {
              backup.calls += 1;
              return Promise.resolve(ok);
            },
          }),
        },
      ],
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    return { provider, primary, backup };
  }

  test("hard_quota calls the provider exactly once and moves to the next", async () => {
    const { provider, primary, backup } = chain("hard_quota");
    const response = await provider.complete(req);
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
    expect(response.provider).toBe("backup");
  });

  test("auth aborts the chain without trying the backup", async () => {
    const { provider, primary, backup } = chain("auth");
    await expect(provider.complete(req)).rejects.toBeInstanceOf(ProviderError);
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(0);
  });

  test("transient_rate_limit retries maxRetries times before falling back", async () => {
    const { provider, primary, backup } = chain("transient_rate_limit");
    const response = await provider.complete(req);
    expect(primary.calls).toBe(3);
    expect(backup.calls).toBe(1);
    expect(response.provider).toBe("backup");
  });

  test("network_timeout is retried like outage, never classified as hard quota", async () => {
    const { provider, primary } = chain("network_timeout");
    await provider.complete(req);
    expect(primary.calls).toBe(3);
  });
});
