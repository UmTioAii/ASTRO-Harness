import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { ConfigError, validateConfig } from "../src/core/config";
import {
  createWebSearchTool, webSearchSecretEnvNames, type WebSearchConfig, type WebSearchDeps,
} from "../src/tools/web-search";

const PRIMARY_SECRET = "primary-web-secret";
const FALLBACK_SECRET = "fallback-web-secret";
/** Provider defaults: the mocked fetch never opens a socket. */
const PRIMARY_BASE = "https://api.exa.ai";
const BRAVE_BASE = "https://api.search.brave.com";
const GOOGLE_BASE = "https://www.googleapis.com/customsearch/v1";

let seq = 0;
function setup(config: WebSearchConfig, overrides: Partial<WebSearchDeps> = {}) {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), `astro-web-fallback-${seq}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const tool = createWebSearchTool({
    config,
    audit,
    env: { PRIMARY_KEY: PRIMARY_SECRET, FALLBACK_KEY: FALLBACK_SECRET },
    sleep: async () => undefined,
    random: () => 0.5,
    ...overrides,
  });
  return { tool, audit, cwd };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "plan" });
const parse = (output: string) => JSON.parse(output) as {
  provider: string;
  results: Array<{ id: number; title: string; url: string; snippet: string }>;
};

type FetchImpl = NonNullable<WebSearchDeps["fetchImpl"]>;

/** Mocked transport routed by endpoint prefix; an unrouted prefix fails like an outage. */
function routedFetch(routes: Array<[string, () => Response]>, calls: string[]): FetchImpl {
  return async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (route === undefined) throw new Error("network down");
    return route[1]();
  };
}

const chain: WebSearchConfig = {
  provider: "exa",
  apiKeyEnv: "PRIMARY_KEY",
  fallback: [{ provider: "brave", apiKeyEnv: "FALLBACK_KEY" }],
};

const base = {
  providers: { p: { kind: "openai-compat", baseUrl: "https://example.test/v1", credentialRef: "P_KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m1", maxSteps: 4, tools: ["web_search"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("webSearch.fallback (#604)", () => {
  test("validates the chain, rejects duplicates and covers every key name", () => {
    const webSearch = (fallback: unknown[]) => ({ provider: "exa", apiKeyEnv: "PRIMARY_KEY", fallback });
    const config = validateConfig({
      ...structuredClone(base),
      webSearch: webSearch([{ provider: "brave", apiKeyEnv: "BRAVE_KEY" }, { provider: "google" }]),
    });
    expect(config.webSearch?.fallback).toEqual([{ provider: "brave", apiKeyEnv: "BRAVE_KEY" }, { provider: "google" }]);
    expect(webSearchSecretEnvNames({ webSearch: config.webSearch })).toEqual(["PRIMARY_KEY", "BRAVE_KEY"]);
    const invalid = (fallback: unknown[]) => () => validateConfig({ ...structuredClone(base), webSearch: webSearch(fallback) });
    expect(invalid([{ provider: "ghost" }])).toThrow(/webSearch\.fallback\[0\]\.provider/);
    expect(invalid([{ provider: "brave" }, { provider: "brave" }])).toThrow(/webSearch\.fallback\[1\]\.provider/);
    expect(invalid([{ provider: "exa" }])).toThrow(/webSearch\.fallback\[0\]\.provider/);
    expect(invalid([{ provider: "custom" }])).toThrow(/fallback\[0\]\.baseUrl/);
    expect(invalid([{ provider: "brave", apiKeyEnv: "sk-live-abcdef123456" }])).toThrow(/fallback\[0\]\.apiKeyEnv/);
  });

  test("accepts a per-entry baseUrl and lets custom into the chain only with one", () => {
    const webSearch = (fallback: unknown[]) => ({ provider: "exa", apiKeyEnv: "PRIMARY_KEY", fallback });
    const config = validateConfig({
      ...structuredClone(base),
      webSearch: webSearch([
        { provider: "brave", apiKeyEnv: "BRAVE_KEY", baseUrl: "https://brave.example.test" },
        { provider: "custom", apiKeyEnv: "BRAVE_KEY", baseUrl: "https://custom.example.test/search" },
      ]),
    });
    expect(config.webSearch?.fallback).toEqual([
      { provider: "brave", apiKeyEnv: "BRAVE_KEY", baseUrl: "https://brave.example.test" },
      { provider: "custom", apiKeyEnv: "BRAVE_KEY", baseUrl: "https://custom.example.test/search" },
    ]);
    const invalid = (fallback: unknown[]) => () => validateConfig({ ...structuredClone(base), webSearch: webSearch(fallback) });
    // `custom` has no default endpoint: without baseUrl the entry is refused naming the field.
    expect(invalid([{ provider: "custom", apiKeyEnv: "BRAVE_KEY" }])).toThrow(ConfigError);
    expect(invalid([{ provider: "custom", apiKeyEnv: "BRAVE_KEY" }])).toThrow(/webSearch\.fallback\[0\]\.baseUrl/);
    // Same URL safety rules as the primary endpoint.
    for (const baseUrl of [
      "ftp://search.example.test",
      "https://user:pass@search.example.test",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      expect(invalid([{ provider: "brave", baseUrl }])).toThrow(ConfigError);
      expect(invalid([{ provider: "brave", baseUrl }])).toThrow(/webSearch\.fallback\[0\]\.baseUrl/);
    }
  });

  test("a fallback entry with a declared baseUrl is called there, including custom", async () => {
    const calls: string[] = [];
    const BRAVE_DECLARED = "https://brave.declared.test";
    const CUSTOM_DECLARED = "https://custom.declared.test";
    const fetchImpl = routedFetch([
      [PRIMARY_BASE, () => new Response("boom", { status: 503 })],
      [BRAVE_DECLARED, () => new Response("boom", { status: 503 })],
      [CUSTOM_DECLARED, () => Response.json({ results: [{ title: "C", url: "https://c.test/p", text: "custom" }] })],
    ], calls);
    const { tool, cwd } = setup({
      provider: "exa",
      apiKeyEnv: "PRIMARY_KEY",
      fallback: [
        { provider: "brave", apiKeyEnv: "FALLBACK_KEY", baseUrl: BRAVE_DECLARED },
        { provider: "custom", apiKeyEnv: "FALLBACK_KEY", baseUrl: CUSTOM_DECLARED },
      ],
    }, { fetchImpl });
    const output = parse((await tool.execute({ query: "astro" }, ctx(cwd))).output);
    expect(output.provider).toBe("custom");
    expect(output.results).toEqual([{ id: 1, title: "C", url: "https://c.test/p", snippet: "custom" }]);
    expect(calls.filter((url) => url.startsWith(`${BRAVE_DECLARED}/res/v1/web/search`))).toHaveLength(3);
    expect(calls.filter((url) => url.startsWith(CUSTOM_DECLARED))).toHaveLength(1);
    // A declared endpoint never falls back to the provider default.
    expect(calls.some((url) => url.startsWith(BRAVE_BASE))).toBe(false);
  });

  test("a transport failure is audited with the direct network reason", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [BRAVE_BASE, () => Response.json({ web: { results: [{ title: "B", url: "https://b.test", description: "ok" }] } })],
    ], calls);
    const { tool, audit, cwd } = setup(chain, { fetchImpl });
    await tool.execute({ query: "astro" }, ctx(cwd));
    const payload = audit.readAll().find((item) => item.tipo === "web.search")?.payload;
    expect((payload?.backends as Array<Record<string, unknown>>)[0])
      .toEqual({ provider: "exa", status: 0, durationMs: expect.any(Number), reason: "network" });
  });

  test("falls back on transport failure and audits bounded codes per backend", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [PRIMARY_BASE, () => new Response("boom", { status: 503 })],
      [BRAVE_BASE, () => Response.json({ web: { results: [
        { title: "A", url: "https://Example.test/p/?utm_source=x", description: "curto" },
        { title: "A2", url: "https://example.test/p", description: "trecho melhor" },
      ] } })],
    ], calls);
    const { tool, audit, cwd } = setup(chain, { fetchImpl });
    const output = parse((await tool.execute({ query: "astro" }, ctx(cwd))).output);
    expect(output.provider).toBe("brave");
    // Dedupe and [n] survive the fallback: one entry, best snippet, id 1.
    expect(output.results).toEqual([{ id: 1, title: "A2", url: "https://example.test/p", snippet: "trecho melhor" }]);
    expect(calls.filter((url) => url.startsWith(PRIMARY_BASE))).toHaveLength(3);
    const payload = audit.readAll().find((item) => item.tipo === "web.search")?.payload;
    expect(payload).toMatchObject({ provider: "brave", status: 200, resultsCount: 1, cacheHit: false, backendsTotal: 2 });
    expect(payload?.backends).toEqual([
      { provider: "exa", status: 503, durationMs: expect.any(Number), reason: "http_503" },
      { provider: "brave", status: 200, durationMs: expect.any(Number) },
    ]);
    const raw = JSON.stringify(audit.readAll());
    expect(raw).not.toContain(PRIMARY_SECRET);
    expect(raw).not.toContain(FALLBACK_SECRET);
    expect(raw).not.toContain(PRIMARY_BASE);
  });

  test("a missing credential and an invalid body fail over with bounded codes", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [BRAVE_BASE, () => new Response("boom", { status: 503 })],
      [GOOGLE_BASE, () => new Response("not json", { status: 200 })],
    ], calls);
    const { tool, audit, cwd } = setup(
      { provider: "exa", apiKeyEnv: "PRIMARY_KEY", fallback: [{ provider: "brave", apiKeyEnv: "FALLBACK_KEY" }, { provider: "google", apiKeyEnv: "FALLBACK_KEY" }] },
      { fetchImpl, env: { FALLBACK_KEY: FALLBACK_SECRET } },
    );
    const result = await tool.execute({ query: "x" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(calls.some((url) => url.startsWith(PRIMARY_BASE))).toBe(false);
    const payload = audit.readAll().find((item) => item.tipo === "web.search")?.payload;
    expect(payload).toMatchObject({ provider: "google", status: 200, resultsCount: 0 });
    expect((payload?.backends as Array<{ reason?: string }>).map((entry) => entry.reason))
      .toEqual(["credential_missing", "http_503", "invalid_body"]);
  });

  test("an aborted backend is audited with the aborted code", async () => {
    const controller = new AbortController();
    const fetchImpl: FetchImpl = async (input) => {
      if (String(input).startsWith(PRIMARY_BASE)) return new Response("boom", { status: 503 });
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    const { tool, audit, cwd } = setup(chain, { fetchImpl });
    const result = await tool.execute({ query: "x" }, { ...ctx(cwd), signal: controller.signal });
    expect(result.output).toContain("cancelada");
    const payload = audit.readAll().find((item) => item.tipo === "web.search")?.payload;
    expect(payload).toMatchObject({ status: 0, resultsCount: 0, backendsTotal: 2 });
    expect(payload?.backends).toEqual([
      { provider: "exa", status: 503, durationMs: expect.any(Number), reason: "http_503" },
      { provider: "brave", status: 0, durationMs: expect.any(Number), reason: "aborted" },
    ]);
  });

  test("a cached fallback hit re-probes the earlier backend and never caches its failure", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [PRIMARY_BASE, () => new Response("boom", { status: 503 })],
      [BRAVE_BASE, () => Response.json({ web: { results: [{ title: "B", url: "https://b.test", description: "ok" }] } })],
    ], calls);
    const { tool, audit, cwd } = setup(chain, { fetchImpl });
    await tool.execute({ query: "astro" }, ctx(cwd));
    await tool.execute({ query: "astro" }, ctx(cwd));
    // The dead primary spends its full budget again; only the answering backend is cached.
    expect(calls.filter((url) => url.startsWith(PRIMARY_BASE))).toHaveLength(6);
    expect(calls.filter((url) => url.startsWith(BRAVE_BASE))).toHaveLength(1);
    expect(audit.readAll().filter((item) => item.tipo === "web.search").map((item) => item.payload?.cacheHit))
      .toEqual([false, true]);
  });

  test("an empty result list is a success and never probes the fallback", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [PRIMARY_BASE, () => Response.json({ results: [] })],
      [BRAVE_BASE, () => Response.json({ web: { results: [{ title: "B", url: "https://b.test", description: "ok" }] } })],
    ], calls);
    const { tool, cwd } = setup(chain, { fetchImpl });
    const output = parse((await tool.execute({ query: "x" }, ctx(cwd))).output);
    expect(output.provider).toBe("exa");
    expect(output.results).toEqual([]);
    expect(calls.some((url) => url.startsWith(BRAVE_BASE))).toBe(false);
  });

  test("a pre-aborted signal stops the chain after the primary", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [PRIMARY_BASE, () => new Response("boom", { status: 503 })],
      [BRAVE_BASE, () => Response.json({ web: { results: [{ title: "B", url: "https://b.test", description: "ok" }] } })],
    ], calls);
    const { tool, audit, cwd } = setup(chain, { fetchImpl });
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute({ query: "x" }, { ...ctx(cwd), signal: controller.signal });
    expect(result.output).toContain("cancelada");
    expect(calls.some((url) => url.startsWith(BRAVE_BASE))).toBe(false);
    expect(audit.readAll().find((item) => item.tipo === "web.search")?.payload?.backends).toEqual([
      { provider: "exa", status: 0, durationMs: expect.any(Number), reason: "aborted" },
    ]);
  });
});
