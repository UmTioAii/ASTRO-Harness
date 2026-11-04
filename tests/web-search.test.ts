import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/config";
import { createWebSearchTool, type WebSearchConfig, type WebSearchDeps } from "../src/tools/web-search";

const HOST_SECRET = ["s", "k", "-"].join("") + "host-secret-123456";
const WEB_SECRET = "web-secret-value";

let seq = 0;
function setup(config: WebSearchConfig, overrides: Partial<WebSearchDeps> = {}) {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), `astro-web-search-${seq}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const tool = createWebSearchTool({
    config,
    audit,
    env: { WEB_KEY: WEB_SECRET, HOST_KEY: HOST_SECRET },
    ...overrides,
  });
  return { tool, audit, cwd };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "plan" });
const parse = (output: string) => JSON.parse(output) as {
  query: string;
  provider: string;
  results: Array<{ title: string; url: string; snippet: string }>;
};

const base = {
  providers: { p: { kind: "openai-compat", baseUrl: "https://example.test/v1", credentialRef: "P_KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 4, tools: ["web_search"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("webSearch config (#57)", () => {
  test("aceita provider, apiKeyEnv nomeada e defaultMaxResults", () => {
    const cfg = validateConfig({
      ...structuredClone(base),
      webSearch: { provider: "exa", apiKeyEnv: "EXA_API_KEY", defaultMaxResults: 3 },
    });
    expect(cfg.webSearch).toEqual({ provider: "exa", apiKeyEnv: "EXA_API_KEY", defaultMaxResults: 3 });
  });

  test("recusa apiKeyEnv que parece segredo (I-03)", () => {
    expect(() => validateConfig({
      ...structuredClone(base),
      webSearch: { provider: "exa", apiKeyEnv: "sk-live-abcdef123456" },
    })).toThrow(/apiKeyEnv/);
  });

  test("recusa provider desconhecido e defaultMaxResults inválido", () => {
    expect(() => validateConfig({
      ...structuredClone(base),
      webSearch: { provider: "ghost", apiKeyEnv: "K" },
    })).toThrow(/provider/);
    expect(() => validateConfig({
      ...structuredClone(base),
      webSearch: { provider: "exa", apiKeyEnv: "K", defaultMaxResults: 0 },
    })).toThrow(/defaultMaxResults/);
  });
});

describe("web_search manifest e validação (#57)", () => {
  test("manifesto: risk low, permission read, timeout 15s e network", async () => {
    const { tool } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" });
    expect(tool.manifest.name).toBe("web_search");
    expect(tool.manifest.risk).toBe("low");
    expect(tool.manifest.permission).toBe("read");
    expect(tool.manifest.timeoutMs).toBe(15000);
    expect(tool.manifest.retryable).toBe(true);
    expect(tool.manifest.sideEffects).toBe("network");
    expect(tool.manifest.description.toLowerCase()).toContain("untrusted");
  });

  test("recusa query vazia e maxResults fora de 1..10", async () => {
    const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" });
    expect(await tool.execute({ query: "  " }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ query: "x", maxResults: 0 }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ query: "x", maxResults: 11 }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ query: "x", recencyDays: 0 }, ctx(cwd))).toMatchObject({ isError: true });
  });

  test("apiKeyEnv ausente do ambiente vira erro", async () => {
    const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "MISSING_KEY" });
    expect(await tool.execute({ query: "x" }, ctx(cwd))).toMatchObject({ isError: true });
  });
});

describe("web_search exa (#57)", () => {
  test("POST /search com x-api-key, normaliza resultados e audita sem segredo do host", async () => {
    const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({
          method: req.method,
          url: req.url,
          headers: Object.fromEntries(req.headers.entries()),
          body: await req.json(),
        });
        return Response.json({
          results: [{ title: "A", url: "https://a.test", text: "trecho A", publishedDate: "2026-01-01" }],
        });
      },
    });
    try {
      const { tool, audit, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "astro harness", maxResults: 3 }, ctx(cwd));
      expect(result.isError).not.toBe(true);
      const body = parse(result.output);
      expect(body.provider).toBe("exa");
      expect(body.results).toEqual([
        { title: "A", url: "https://a.test", snippet: "trecho A" },
      ]);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(`${server.url.origin}/search`);
      expect(requests[0]?.headers["x-api-key"]).toBe(WEB_SECRET);
      expect(requests[0]?.body).toMatchObject({ query: "astro harness", numResults: 3 });
      expect(JSON.stringify(requests)).not.toContain(HOST_SECRET);
      const event = audit.readAll().find((item) => item.tipo === "web.search");
      expect(event?.payload).toMatchObject({
        provider: "exa", resultsCount: 1, status: 200, query: "astro harness",
      });
      expect(JSON.stringify(event)).not.toContain(HOST_SECRET);
    } finally {
      server.stop(true);
    }
  });

  test("erro do backend vira resultado redigido", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(`boom ${HOST_SECRET}`, { status: 500 }) });
    try {
      const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "x" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain(HOST_SECRET);
    } finally {
      server.stop(true);
    }
  });
});
