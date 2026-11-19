import { describe, expect, test } from "bun:test";
import { OpenAICompatProvider } from "../src/providers/openai-compat";
import { ProviderError, type CompletionRequest } from "../src/providers/types";

const req: CompletionRequest = { model: "m", messages: [{ role: "user", content: "oi" }] };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const okBody = {
  choices: [{ message: { content: "ok" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

function provider(fetchFn: (input: unknown, init?: RequestInit) => Promise<Response>, extra: Record<string, unknown> = {}) {
  return new OpenAICompatProvider({
    baseUrl: "http://loopback/v1",
    apiKey: "k",
    fetchFn: fetchFn as never,
    retry: { maxAttempts: 3, windowMs: 60_000 },
    sleepFn: async () => {},
    ...extra,
  });
}

async function errClassOf(p: OpenAICompatProvider): Promise<ProviderError> {
  const error = await p.complete(req).catch((e) => e);
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe("adapter polish: classification (#554)", () => {
  test("402 payment required is hard_quota and never retried", async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      return json({ detail: "quota exceeded" }, 402);
    });
    const error = await errClassOf(p);
    expect(error.errClass).toBe("hard_quota");
    expect(calls).toBe(1);
  });

  test("408 and 425 are network_timeout, never hard_quota", async () => {
    for (const status of [408, 425]) {
      const p = provider(async () => json({ error: { message: "slow down" } }, status));
      const error = await errClassOf(p);
      expect(error.errClass).toBe("network_timeout");
    }
  });

  test("NVIDIA/FastAPI error body uses `detail` and it reaches the message", async () => {
    const p = provider(async () => json({ detail: "model overloaded" }, 503), { retry: { maxAttempts: 1, windowMs: 1000 } });
    const error = await errClassOf(p);
    expect(error.errClass).toBe("outage");
    expect(error.message).toContain("model overloaded");
  });

  test("429 with quota code in `detail` is hard_quota, not transient", async () => {
    const p = provider(async () => json({ detail: "insufficient_quota" }, 429), { retry: { maxAttempts: 1, windowMs: 1000 } });
    const error = await errClassOf(p);
    expect(error.errClass).toBe("hard_quota");
  });

  test("SSE error frame with quota code classifies hard_quota, not outage", async () => {
    const sse = (frames: string[]) =>
      new Response(frames.map((f) => `data: ${f}\n\n`).join("") + "data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const p = provider(async () =>
      sse([JSON.stringify({ error: { code: "insufficient_quota", message: "quota exceeded" } })]),
    );
    const error = await p.complete({ ...req, onToken: () => {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).errClass).toBe("hard_quota");
  });
});

describe("adapter polish: loopback drop/reset/5xx (#554)", () => {
  test("reset, 503 then success: retried per matrix, never misclassified", async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      if (calls === 1) {
        const cause = new Error("read ECONNRESET");
        throw new TypeError("fetch failed", { cause });
      }
      if (calls === 2) return json({ detail: "upstream down" }, 503);
      return json(okBody);
    });
    const response = await p.complete(req);
    expect(response.content).toBe("ok");
    expect(calls).toBe(3);
  });

  test("a hung server is cut by the own timeout and classified network_timeout", async () => {
    const p = provider(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason));
        }),
      { timeoutMs: 50, retry: { maxAttempts: 1, windowMs: 1000 } },
    );
    const startedAt = Date.now();
    const error = await errClassOf(p);
    expect(error.errClass).toBe("network_timeout");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("drop mid-stream is outage and is not retried after tokens were emitted", async () => {
    let calls = 0;
    const p = provider(async () => {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
          // O drop chega depois do chunk: o token já foi emitido (streamStarted).
          setTimeout(() => controller.error(new TypeError("read ECONNRESET")), 5);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const error = await p.complete({ ...req, onToken: () => {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).errClass).toBe("outage");
    expect(calls).toBe(1);
  });
});
