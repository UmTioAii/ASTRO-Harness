import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { validateConfig } from "../src/core/config";
import { canonicalUrl, createWebSearchTool, searchCacheKey, webSearchSecretEnvNames, type WebSearchConfig, type WebSearchDeps } from "../src/tools/web-search";

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
  results: Array<{ id: number; title: string; url: string; snippet: string }>;
};

type FetchImpl = NonNullable<WebSearchDeps["fetchImpl"]>;

/** Mocked transport: the suite never opens a socket for the #604 cases. */
function mockFetch(handler: (url: string) => Response): FetchImpl {
  return async (input: string | URL | Request) => handler(String(input));
}

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
          results: [null, { title: "A", url: "https://a.test", text: "trecho A" }],
        });
      },
    });
    try {
      const { tool, audit, cwd } = setup({
        provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin, defaultMaxResults: 3,
      });
      const result = await tool.execute({ query: "astro harness" }, ctx(cwd));
      expect(result.isError).not.toBe(true);
      const body = parse(result.output);
      expect(body.provider).toBe("exa");
      expect(body.results).toEqual([
        { id: 1, title: "A", url: "https://a.test", snippet: "trecho A" },
      ]);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.url).toBe(`${server.url.origin}/search`);
      expect(requests[0]?.headers["x-api-key"]).toBe(WEB_SECRET);
      expect(requests[0]?.body).toMatchObject({
        query: "astro harness",
        numResults: 3,
        contents: { text: { maxCharacters: 500 } },
      });
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

  test("não segue redirect e não entrega a chave a outro host", async () => {
    let leaked = 0;
    const target = Bun.serve({
      port: 0,
      fetch() { leaked += 1; return Response.json({ results: [] }); },
    });
    const source = Bun.serve({
      port: 0,
      fetch() { return new Response(null, { status: 307, headers: { location: target.url.toString() } }); },
    });
    try {
      const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: source.url.origin });
      const result = await tool.execute({ query: "x" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(leaked).toBe(0);
    } finally {
      source.stop(true);
      target.stop(true);
    }
  });

  test("200 com corpo inválido falha e audita a chamada", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not json", { status: 200 }) });
    try {
      const { tool, audit, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: "x" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(audit.readAll().find((item) => item.tipo === "web.search")?.payload)
        .toMatchObject({ status: 200, resultsCount: 0 });
    } finally {
      server.stop(true);
    }
  });

  test("webSearchSecretEnvNames entrega o nome da chave ao filtro do shell", () => {
    expect(webSearchSecretEnvNames({})).toEqual([]);
    expect(webSearchSecretEnvNames({ webSearch: { provider: "exa", apiKeyEnv: "EXA_KEY" } })).toEqual(["EXA_KEY"]);
  });
});

describe("web_search canonical dedupe, citations and cache (#604)", () => {
  test("canonicalUrl normalizes scheme/host, default port, trailing slash, tracking params, order and fragment", () => {
    expect(canonicalUrl("HTTPS://Example.TEST:443/post/?utm_source=x&b=1&a=2#top"))
      .toBe("https://example.test/post?a=2&b=1");
    expect(canonicalUrl("https://example.test/")).toBe("https://example.test/");
    expect(canonicalUrl("not a url")).toBe("not a url");
  });

  test("canonicalUrl treats http and https of the same page as one URL", () => {
    expect(canonicalUrl("http://example.test/p")).toBe(canonicalUrl("https://example.test/p"));
    expect(canonicalUrl("http://example.test:80/p")).toBe("https://example.test/p");
  });

  test("the retained cache key is a digest, never the query text (#604, I-03)", () => {
    // Segredo sintético em runtime (gate G6: sem literal de segredo no diff).
    const CACHE_SECRET = ["s", "k", "-"].join("") + "cache-key-synthetic-1234";
    const key = searchCacheKey({ provider: "exa", query: `busca ${CACHE_SECRET}`, maxResults: 5 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(CACHE_SECRET);
    // Canonical-equivalent queries share the key; distinct secrets never collapse.
    expect(searchCacheKey({ provider: "exa", query: "  ASTRO  harness ", maxResults: 5 }))
      .toBe(searchCacheKey({ provider: "exa", query: "astro harness", maxResults: 5 }));
    expect(searchCacheKey({ provider: "exa", query: `busca ${CACHE_SECRET}`, maxResults: 5 }))
      .not.toBe(searchCacheKey({ provider: "exa", query: "busca outro-valor-sintetico", maxResults: 5 }));
  });

  test("the cache key is scoped to the resolved backend, not only to the query", () => {
    const options = { query: "astro", maxResults: 5 };
    const declared = searchCacheKey({ provider: "brave", baseUrl: "https://a.search.test", ...options });
    expect(declared).not.toBe(searchCacheKey({ provider: "brave", baseUrl: "https://b.search.test", ...options }));
    expect(declared).not.toBe(searchCacheKey({ provider: "exa", baseUrl: "https://a.search.test", ...options }));
    expect(declared).not.toBe(searchCacheKey({ provider: "brave", ...options }));
  });

  test("collapses duplicates by canonical URL keeping the best snippet and the first position", async () => {
    const fetchImpl = mockFetch(() => Response.json({
      results: [
        { title: "A", url: "https://Example.test/post/?utm_source=x#top", text: "curto" },
        { title: "A2", url: "https://example.test/post?utm_source=y", text: "um trecho bem mais completo" },
        { title: "C", url: "https://other.test/", text: "outro" },
      ],
    }));
    const { tool, audit, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" }, { fetchImpl });
    const result = await tool.execute({ query: "astro" }, ctx(cwd));
    const body = parse(result.output);
    // Position comes from the first occurrence; url, title and snippet come from
    // the same (best) entry — never a mix of two results.
    expect(body.results.map((item) => item.url)).toEqual([
      "https://example.test/post?utm_source=y",
      "https://other.test/",
    ]);
    expect(body.results.map((item) => item.title)).toEqual(["A2", "C"]);
    expect(body.results.map((item) => item.snippet)).toEqual(["um trecho bem mais completo", "outro"]);
    expect(body.results.map((item) => item.id)).toEqual([1, 2]);
    expect(audit.readAll().find((item) => item.tipo === "web.search")?.payload)
      .toMatchObject({ resultsCount: 2, cacheHit: false });
  });

  test("a provider ignoring maxResults cannot inflate the result list or the cache", async () => {
    const fetchImpl = mockFetch(() => Response.json({
      results: Array.from({ length: 50 }, (_, index) => ({
        title: `T${index}`, url: `https://a.test/${index}`, text: "trecho",
      })),
    }));
    const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" }, { fetchImpl });
    const body = parse((await tool.execute({ query: "astro", maxResults: 2 }, ctx(cwd))).output);
    expect(body.results.map((item) => item.url)).toEqual(["https://a.test/0", "https://a.test/1"]);
  });

  test("manifest tells the model to cite results by [n]", () => {
    const { tool } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" });
    expect(tool.manifest.description).toContain("[n]");
  });

  test("an identical canonical query and options is served from the bounded cache and audited as a hit", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return Response.json({ results: [{ title: "A", url: "https://a.test/p", text: "trecho" }] });
    });
    const { tool, audit, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" }, { fetchImpl });
    const first = parse((await tool.execute({ query: "astro harness", maxResults: 5 }, ctx(cwd))).output);
    const second = parse((await tool.execute({ query: "  ASTRO   harness ", maxResults: 5 }, ctx(cwd))).output);
    expect(calls).toBe(1);
    expect(second).toMatchObject({ results: first.results });
    const events = audit.readAll().filter((item) => item.tipo === "web.search");
    expect(events.map((item) => item.payload?.cacheHit)).toEqual([false, true]);
    expect(events[1]?.payload).toMatchObject({ cacheHit: true, status: 200, resultsCount: 1 });
    // Different options are a different key: no false hit.
    await tool.execute({ query: "astro harness", maxResults: 4 }, ctx(cwd));
    expect(calls).toBe(2);
  });

  test("ids are unique inside a run and restart in a new run, and the cache never crosses runs", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return Response.json({ results: [{ title: "A", url: "https://a.test/p", text: "trecho" }] });
    });
    const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" }, { fetchImpl });
    expect(parse((await tool.execute({ query: "astro" }, ctx(cwd))).output).results[0]?.id).toBe(1);
    expect(parse((await tool.execute({ query: "other" }, ctx(cwd))).output).results[0]?.id).toBe(2);
    const restarted = parse((await tool.execute({ query: "astro" }, { ...ctx(cwd), run: "r2" })).output);
    expect(restarted.results[0]?.id).toBe(1);
    expect(calls).toBe(3);
  });

  test("only successful calls are cached", async () => {
    let calls = 0;
    let fail = true;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return fail
        ? new Response("boom", { status: 500 })
        : Response.json({ results: [{ title: "A", url: "https://a.test/p", text: "trecho" }] });
    });
    const { tool, cwd } = setup(
      { provider: "exa", apiKeyEnv: "WEB_KEY" },
      { fetchImpl, sleep: async () => undefined, random: () => 0.5 },
    );
    expect((await tool.execute({ query: "astro" }, ctx(cwd))).isError).toBe(true);
    expect((await tool.execute({ query: "astro" }, ctx(cwd))).isError).toBe(true);
    expect(calls).toBe(6); // 3 attempts per call: a failure never enters the cache
    fail = false;
    expect((await tool.execute({ query: "astro" }, ctx(cwd))).isError).not.toBe(true);
    expect(calls).toBe(7);
  });

  test("a cached call still requires the credential, and the missing one is audited", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return Response.json({ results: [{ title: "A", url: "https://a.test/p", text: "trecho" }] });
    });
    const env: Record<string, string | undefined> = { WEB_KEY: "web-secret-value" };
    const { tool, audit, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY" }, { fetchImpl, env });
    expect((await tool.execute({ query: "astro" }, ctx(cwd))).isError).not.toBe(true);
    env.WEB_KEY = undefined;
    const result = await tool.execute({ query: "astro" }, ctx(cwd));
    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain("WEB_KEY");
    expect(calls).toBe(1);
    const events = audit.readAll().filter((item) => item.tipo === "web.search");
    expect(events.map((item) => item.payload?.status)).toEqual([200, 0]);
    expect(events[1]?.payload).toMatchObject({ resultsCount: 0, cacheHit: false });
  });

  test("cache eviction keeps the cache bounded", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return Response.json({ results: [{ title: "A", url: "https://a.test/p", text: "trecho" }] });
    });
    const { tool, cwd } = setup(
      { provider: "exa", apiKeyEnv: "WEB_KEY" },
      { fetchImpl, cacheMaxEntries: 1 },
    );
    await tool.execute({ query: "one" }, ctx(cwd));
    await tool.execute({ query: "two" }, ctx(cwd));
    await tool.execute({ query: "one" }, ctx(cwd));
    expect(calls).toBe(3);
  });
});

describe("web_search redação de url/query no output (ADR-0027, I-03)", () => {

  // Segredo sintético construído em runtime (gate G6: sem literal de segredo no diff).
  const SEARCH_SECRET = ["s", "k", "-"].join("") + "slice3a-search-synthetic-77aa88";

  test("redige query e url dos resultados na origem, antes do JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        results: [{ title: "T", url: `https://a.test/p?token=${SEARCH_SECRET}`, text: "trecho" }],
      }),
    });
    try {
      const { tool, cwd } = setup({ provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: server.url.origin });
      const result = await tool.execute({ query: `busca ${SEARCH_SECRET}` }, ctx(cwd));
      expect(result.isError).not.toBe(true);
      expect(result.output).not.toContain(SEARCH_SECRET);
      const body = parse(result.output);
      expect(body.query).toContain("[REDACTED]");
      expect(body.query).not.toContain(SEARCH_SECRET);
      expect(body.results[0]!.url).toContain("[REDACTED]");
      expect(body.results[0]!.url).not.toContain(SEARCH_SECRET);
    } finally {
      server.stop(true);
    }
  });
});
