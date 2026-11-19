import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, RETRYABLE_CLASSES, errorPolicy, maxRetriesFor, type ErrorAction } from "../src/providers/policy";
import { FallbackProvider } from "../src/providers/fallback-provider";
import { OpenAICompatProvider, parseRetryAfter, retryDelayMs } from "../src/providers/openai-compat";
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

  test("RETRYABLE_CLASSES and maxRetriesFor agree on the retryable set", () => {
    expect([...RETRYABLE_CLASSES].sort()).toEqual(["network_timeout", "outage", "transient_rate_limit"]);
    for (const c of ALL_CLASSES) {
      expect(RETRYABLE_CLASSES.has(c)).toBe(maxRetriesFor(c) > 0);
    }
  });

  test("exact action per class at attempt 0, the last retry and the limit", () => {
    const matrix: Array<[ErrorClass, number, ErrorAction, ErrorAction]> = [
      ["transient_rate_limit", DEFAULT_LIMITS.maxRateLimitRetries, "retry_after", "fallback"],
      ["outage", DEFAULT_LIMITS.maxOutageRetries, "retry_backoff", "fallback"],
      ["network_timeout", DEFAULT_LIMITS.maxOutageRetries, "retry_backoff", "fallback"],
      ["hard_quota", 100, "skip", "skip"],
      ["auth", 100, "abort", "abort"],
      ["invalid_request", 100, "abort", "abort"],
    ];
    for (const [cls, limit, atZero, atLimit] of matrix) {
      expect(errorPolicy(cls, 0)).toBe(atZero);
      expect(errorPolicy(cls, limit - 1)).toBe(atZero);
      expect(errorPolicy(cls, limit)).toBe(atLimit);
    }
  });

  test("custom limits change the retry cap per class", () => {
    expect(maxRetriesFor("transient_rate_limit", { maxRateLimitRetries: 2 })).toBe(2);
    expect(maxRetriesFor("network_timeout", { maxOutageRetries: 1 })).toBe(1);
    expect(maxRetriesFor("hard_quota", { maxRateLimitRetries: 9, maxOutageRetries: 9 })).toBe(0);
  });
});

describe("openai-compat retry delay (#556)", () => {
  test("parseRetryAfter reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(" 1.5 ")).toBe(1_500);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
    const date = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfter(date);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(5_000);
  });

  test("Retry-After wins over the exponential base for the same attempt", () => {
    // attempt 1: base 250ms * jitter (<= 312.5ms); the 30s header must dominate.
    expect(retryDelayMs(1, 30_000, 60_000)).toBe(30_000);
  });

  test("backoff grows exponentially with jitter and caps at MAX_BACKOFF_MS bounds", () => {
    const first = retryDelayMs(1, undefined, 60_000);
    expect(first).toBeGreaterThanOrEqual(187.5);
    expect(first).toBeLessThanOrEqual(312.5);
    // attempt 10: base capped at 10s; jitter ±25% -> (7500, 12500]
    const late = retryDelayMs(10, undefined, 60_000);
    expect(late).toBeGreaterThanOrEqual(7_500);
    expect(late).toBeLessThanOrEqual(12_500);
  });

  test("no delay when the window is exhausted or the header exceeds it", () => {
    expect(retryDelayMs(1, undefined, 0)).toBeNull();
    expect(retryDelayMs(1, 30_000, 1_000)).toBeNull();
  });

  test("adapter stops at maxAttempts on a persistent rate limit", async () => {
    let calls = 0;
    const p = new OpenAICompatProvider({
      baseUrl: "http://x/v1",
      apiKey: "k",
      fetchFn: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "rate" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      },
      retry: { maxAttempts: 3, windowMs: 60_000 },
    });
    const error = (await p.complete(req).catch((e) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.errClass).toBe("transient_rate_limit");
    expect(calls).toBe(3);
  });
});

describe("FallbackProvider honors the matrix (#556)", () => {
  function chain(errClass: ErrorClass, maxRetries = 2) {
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
      maxRetries,
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

  test("auth is never retried on the same provider; the hard error skips to the next (C6 semantics)", async () => {
    const { provider, primary, backup } = chain("auth");
    const response = await provider.complete(req);
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
    expect(response.provider).toBe("backup");
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

  test("maxRetries: 0 disables the same-provider retry even for transient classes", async () => {
    const { provider, primary, backup } = chain("outage", 0);
    const response = await provider.complete(req);
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
    expect(response.provider).toBe("backup");
  });

  test("single provider + hard_quota throws after exactly one call", async () => {
    const primary = { calls: 0 };
    const provider = new FallbackProvider({
      providers: [{ name: "only", priority: 1, create: () => failing("hard_quota", primary) }],
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    await expect(provider.complete(req)).rejects.toBeInstanceOf(ProviderError);
    expect(primary.calls).toBe(1);
  });
});
