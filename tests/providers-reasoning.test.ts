import { describe, expect, test } from "bun:test";
import { createProvider } from "../src/core/app";
import { validateConfig } from "../src/core/config";
import { Registry } from "../src/core/registry";
import { OpenAICompatProvider } from "../src/providers/openai-compat";

const message = { role: "user" as const, content: "oi" };

function completion(entry: Record<string, unknown>, usage = { prompt_tokens: 3, completion_tokens: 7 }): Response {
  return Response.json({ choices: [{ message: entry }], usage });
}

describe("reasoning channel in the openai-compat adapter (#600)", () => {
  test("exposes reasoning_content when the model card declares reasoning", async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: "http://mock/v1",
      reasoning: true,
      fetchFn: async () => completion({ content: "ok", reasoning_content: "passo 1\npasso 2" }),
    });

    const response = await provider.complete({ model: "m1", messages: [message] });

    expect(response.reasoning).toBe("passo 1\npasso 2");
    expect(response.content).toBe("ok");
  });

  test("a model card without reasoning emits no reasoning, even when the wire carries reasoning_content", async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: "http://mock/v1",
      fetchFn: async () => completion({ content: "ok", reasoning_content: "ignorado" }),
    });

    const response = await provider.complete({ model: "m1", messages: [message] });

    expect(response.reasoning).toBeUndefined();
  });

  test("streaming collects reasoning_content deltas without mixing them into content or onToken", async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"reasoning_content":"passo "}}]}\n\n`,
      `data: {"choices":[{"delta":{"reasoning_content":"um"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
      `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":9}}\n\n`,
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const provider = new OpenAICompatProvider({
      baseUrl: "http://mock/v1",
      reasoning: true,
      fetchFn: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });

    const tokens: string[] = [];
    const response = await provider.complete({
      model: "m1",
      messages: [message],
      onToken: (text) => tokens.push(text),
    });

    expect(response.reasoning).toBe("passo um");
    expect(tokens).toEqual(["ok"]);
    // Reasoning tokens are already counted by the provider; a second copy would inflate the ledger.
    expect(response.usage.outputTokens).toBe(9);
  });

  test("createProvider follows the model card and a card without reasoning exposes none", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => completion({ content: "ok", reasoning_content: "plano do modelo" }),
    });
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    const providerConfig = { kind: "openai-compat", baseUrl } as const;
    const paths = { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" };
    try {
      const reasoning = validateConfig({
        providers: { codex: providerConfig },
        models: [{ provider: "codex", id: "gpt-5.5", tags: ["writing-code"], context: 400000 }],
        agent: { model: "codex/gpt-5.5", maxSteps: 1, tools: [] },
        paths,
      });
      const reasoningModel = new Registry(reasoning).require("codex/gpt-5.5");
      const declared = await createProvider(reasoning, reasoningModel, {}).provider.complete({
        model: "gpt-5.5", messages: [message],
      });
      expect(declared.reasoning).toBe("plano do modelo");
      const plain = validateConfig({
        providers: { openrouter: providerConfig },
        models: [{ provider: "openrouter", id: "openai/gpt-4o-mini", tags: ["writing-code"], context: 128000 }],
        agent: { model: "openrouter/openai/gpt-4o-mini", maxSteps: 1, tools: [] },
        paths,
      });
      const plainModel = new Registry(plain).require("openrouter/openai/gpt-4o-mini");
      const absent = await createProvider(plain, plainModel, {}).provider.complete({
        model: "openai/gpt-4o-mini", messages: [message],
      });
      expect(absent.reasoning).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
