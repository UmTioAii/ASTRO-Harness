import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { outputCeilingChars } from "../src/tools/contract";
import { ToolExecutor } from "../src/tools/executor";
import { createWebFetchTool } from "../src/tools/web-fetch";
import { createWebSearchTool, type WebSearchConfig } from "../src/tools/web-search";
import { createSearchAndReadTool, DEFAULT_DEPTH, MAX_DEPTH } from "../src/tools/web-search-read";
import type { ToolExecutorLike } from "../src/tools/types";

const WEB_SECRET = "web-secret-value";
const SEARCH_BASE = "https://search.test";
const PAGE = "http://127.0.0.1";
const ALLOW = ["web_search", "web_fetch", "search_and_read"];

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type Body = {
  depth: number; untrusted: boolean; provider?: string; truncated?: boolean; notice?: string;
  results: Array<{ id: number; title?: string; url?: string; content?: string; readError?: string }>;
};

let seq = 0;
let callSeq = 0;

interface SetupOptions {
  fetchImpl?: FetchImpl;
  allow?: string[];
  allowPrivate?: boolean;
  config?: WebSearchConfig;
}

function setup(opts: SetupOptions = {}) {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), `astro-search-read-${seq}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const config = opts.config ?? { provider: "exa" as const, apiKeyEnv: "WEB_KEY", baseUrl: SEARCH_BASE };
  const fetchImpl = opts.fetchImpl ?? (async () => { throw new Error("network down"); });
  const searchTool = createWebSearchTool({
    config, audit, env: { WEB_KEY: WEB_SECRET }, fetchImpl,
    sleep: async () => undefined, random: () => 0.5,
  });
  const fetchTool = createWebFetchTool({ audit, fetchImpl, allowPrivate: opts.allowPrivate ?? true });
  const tool = createSearchAndReadTool({ audit });
  const executor = new ToolExecutor({
    tools: [searchTool, fetchTool, tool],
    allow: opts.allow ?? [...ALLOW],
    audit,
    permissionMode: "bypass",
  });
  return { tool, executor, audit, cwd };
}

const ctx = (cwd: string, extra: Record<string, unknown> = {}) =>
  ({ cwd, run: "r1", agent: "plan", allow: [...ALLOW], ...extra });

/** Runs a real tool through a real ToolExecutor, exactly like the session does. */
function run(
  executor: ToolExecutor, cwd: string, name: string, input: unknown, extra: Record<string, unknown> = {},
) {
  callSeq += 1;
  return executor.run(ctx(cwd, extra), { id: `call-${callSeq}`, name, arguments: JSON.stringify(input) });
}

/** Mocked transport: the suite never opens a socket. */
function routedFetch(routes: Array<[string, () => Response]>, calls: string[]): FetchImpl {
  return async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (route === undefined) throw new Error("network down");
    return route[1]();
  };
}

const search = (items: Array<{ title: string; url: string; text: string }>) => () => Response.json({ results: items });
const page = (body: string, type = "text/html") => () => new Response(body, { headers: { "content-type": type } });
const parse = (output: string): Body => JSON.parse(output) as Body;

describe("search_and_read manifest and depth (#604)", () => {
  test("declares the output ceiling and tells the model to cite [n] and distrust content", () => {
    const { tool } = setup();
    expect(tool.manifest.name).toBe("search_and_read");
    expect(tool.manifest).toMatchObject({ risk: "low", permission: "read", timeoutMs: 15000, sideEffects: "network" });
    expect(tool.manifest.output?.maxTokens).toBeGreaterThan(0);
    expect(tool.manifest.description).toContain("[n]");
    expect(tool.manifest.description.toLowerCase()).toContain("untrusted");
  });

  test("depth defaults to 3, accepts 1..5 and rejects the rest before any network call", async () => {
    const calls: string[] = [];
    const { executor, cwd } = setup({ fetchImpl: routedFetch([], calls) });
    expect(DEFAULT_DEPTH).toBe(3); expect(MAX_DEPTH).toBe(5);
    for (const depth of [0, 6, 1.5, "2"]) {
      expect(await run(executor, cwd, "search_and_read", { query: "astro", depth }))
        .toMatchObject({ isError: true, failure: "invalid" });
    }
    expect(calls).toEqual([]);
  });
});

describe("search_and_read reads the top results (#604)", () => {
  test("reads only the top depth, keeps the search [n] ids and sanitizes the page", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([
        { title: "One", url: `${PAGE}/1`, text: "s1" },
        { title: "Two", url: `${PAGE}/2`, text: "s2" },
        { title: "Three", url: `${PAGE}/3`, text: "s3" },
      ])],
      [`${PAGE}/1`, page("<h1>One</h1><script>alert(1)</script><p>body one</p>")],
      [`${PAGE}/2`, page("body two", "text/plain")],
      [`${PAGE}/3`, page("<p>body three</p>")],
    ], calls);
    const { executor, cwd } = setup({ fetchImpl });
    const result = await run(executor, cwd, "search_and_read", { query: "astro", depth: 2 });
    expect(result.isError).not.toBe(true);
    const body = parse(result.output);
    expect(body.depth).toBe(2); expect(body.untrusted).toBe(true);
    expect(body.results.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(body.results[0]).toMatchObject({ title: "One", url: `${PAGE}/1` });
    expect(body.results[0]?.content).toContain("body one"); expect(body.results[0]?.content).not.toContain("alert");
    expect(body.results[1]?.content).toBe("body two"); expect(body.results[2]?.content).toBeUndefined();
    expect(calls.filter((url) => url.startsWith(PAGE))).toHaveLength(2);
  });

  test("a page beyond the ceiling is cut, not dropped, and the read stops at the budget", async () => {
    const long = "x".repeat(5000);
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([
        { title: "A", url: `${PAGE}/a`, text: "a" },
        { title: "B", url: `${PAGE}/b`, text: "b" },
      ])],
      [`${PAGE}/a`, page(`<p>${long}</p>`)],
      [`${PAGE}/b`, page(`<p>${long}</p>`)],
    ], []);
    const { executor, audit, cwd, tool } = setup({ fetchImpl });
    const tight = { outputLimitTokens: 500 };
    const result = await run(executor, cwd, "search_and_read", { query: "astro", maxResults: 2, depth: 2 }, tight);
    expect(result.isError).not.toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(outputCeilingChars(tool.manifest.output, tight)!);
    const body = parse(result.output);
    expect(body.results.map((item) => item.id)).toEqual([1, 2]);
    expect(body.results.every((item) => typeof item.content === "string" && item.content.length > 0)).toBe(true);
    expect(body.truncated).toBe(true); expect(body.notice).toContain("[output truncated:");
    expect(body.notice).toContain("characters omitted"); expect(body.notice).not.toContain("pages omitted");
    expect(result.truncation).toMatchObject({ unit: "characters" });
    expect(result.truncation?.removed ?? 0).toBeGreaterThan(0);
    // total counts the text the read step actually fetched (bounded by the
    // budget), so it is characters, not a claim about the whole page.
    expect(result.truncation?.total ?? 0).toBeGreaterThan(result.truncation?.removed ?? 0);
    // The page read is capped by the budget, not by web_fetch's 50k default.
    const fetched = audit.readAll().filter((item) => item.tipo === "web.fetch");
    expect(fetched.every((item) => Number(item.payload?.contentLength) < 5000)).toBe(true);
  });
});

describe("search_and_read shares web_search state (#604)", () => {
  test("shares the run [n] ids and the cache with web_search", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(`${SEARCH_BASE}/search`)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        const name = body.query === "alpha" ? "alpha" : "beta";
        return Response.json({
          results: ["1", "2"].map((n) => ({ title: `${name}${n}`, url: `${PAGE}/${name}/${n}`, text: "t" })),
        });
      }
      return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
    };
    const { executor, audit, cwd } = setup({ fetchImpl });
    const alpha = await run(executor, cwd, "web_search", { query: "alpha" });
    expect(parse(alpha.output).results.map((item) => item.id)).toEqual([1, 2]);
    const beta = await run(executor, cwd, "search_and_read", { query: "beta", depth: 1 });
    expect(parse(beta.output).results.map((item) => item.id)).toEqual([3, 4]);
    const alphaRead = await run(executor, cwd, "search_and_read", { query: "alpha", depth: 1 });
    expect(parse(alphaRead.output).results.map((item) => item.id)).toEqual([1, 2]);
    expect(calls.filter((url) => url.startsWith(`${SEARCH_BASE}/search`))).toHaveLength(2);
    const searchEvents = audit.readAll().filter((event) => event.tipo === "web.search");
    expect(searchEvents.map((event) => event.payload?.cacheHit)).toEqual([false, false, true]);
  });
});

describe("search_and_read cache, fallback and audit (#604)", () => {
  test("reuses the web_search cache and audits the host without the key", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([{ title: "A", url: `${PAGE}/p`, text: "trecho" }])],
      [`${PAGE}/p`, page("<p>page</p>")],
    ], calls);
    const { executor, audit, cwd } = setup({ fetchImpl });
    expect((await run(executor, cwd, "search_and_read", { query: "astro harness", depth: 1 })).isError).not.toBe(true);
    expect((await run(executor, cwd, "search_and_read", { query: "ASTRO   harness", depth: 1 })).isError).not.toBe(true);
    expect(calls.filter((url) => url.startsWith(`${SEARCH_BASE}/search`))).toHaveLength(1);
    const searchEvents = audit.readAll().filter((event) => event.tipo === "web.search");
    expect(searchEvents.map((event) => event.payload?.cacheHit)).toEqual([false, true]);
    const readEvents = audit.readAll().filter((event) => event.tipo === "web.read");
    expect(readEvents[0]?.payload).toMatchObject({ depth: 1, resultsCount: 1, readCount: 1, failedCount: 0 });
    const auditText = JSON.stringify(audit.readAll());
    // I-04 traceability: two sites read in one run stay distinguishable by host.
    expect(auditText).toContain("127.0.0.1");
    expect(auditText).not.toContain(WEB_SECRET);
    const fetchEvent = audit.readAll().find((event) => event.tipo === "web.fetch");
    expect(fetchEvent?.payload).toMatchObject({ url: `${PAGE}/p` });
  });

  test("moves to the next declared backend like web_search", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${PAGE}/p`, page("<p>ok</p>")],
      ["https://api.search.brave.com", () => Response.json({
        web: { results: [{ title: "B", url: `${PAGE}/p`, description: "trecho" }] },
      })],
    ], calls);
    const { executor, audit, cwd } = setup({
      config: {
        provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: SEARCH_BASE,
        fallback: [{ provider: "brave", apiKeyEnv: "WEB_KEY" }],
      },
      fetchImpl,
    });
    const result = await run(executor, cwd, "search_and_read", { query: "astro", depth: 1 });
    expect(result.isError).not.toBe(true);
    expect(parse(result.output).provider).toBe("brave");
    expect(parse(result.output).results[0]).toMatchObject({ id: 1, url: `${PAGE}/p` });
    const event = audit.readAll().find((item) => item.tipo === "web.search");
    expect(event?.payload?.backends).toMatchObject([
      { provider: "exa", reason: "network" },
      { provider: "brave" },
    ]);
  });

  test("a failed read keeps the tool green and reports the id with a bounded reason", async () => {
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([
        { title: "A", url: `${PAGE}/a`, text: "a" },
        { title: "B", url: `${PAGE}/b`, text: "b" },
        { title: "C", url: `${PAGE}/c`, text: "c" },
      ])],
      [`${PAGE}/a`, page("<p>ok</p>")],
      [`${PAGE}/b`, () => new Response("nope", { status: 404 })],
      [`${PAGE}/c`, page("%PDF-1.7", "application/pdf")],
    ], []);
    const { executor, audit, cwd } = setup({ fetchImpl });
    const result = await run(executor, cwd, "search_and_read", { query: "astro" });
    expect(result.isError).not.toBe(true);
    const body = parse(result.output);
    expect(body.depth).toBe(3);
    expect(body.results[0]?.content).toContain("ok");
    expect(body.results[1]).toMatchObject({ id: 2, readError: "http_404" });
    expect(body.results[2]).toMatchObject({ id: 3, readError: "content_type" });
    const readEvent = audit.readAll().find((item) => item.tipo === "web.read");
    expect(readEvent?.payload).toMatchObject({ readCount: 1, failedCount: 2 });
  });

  test("a redirect blocked by the URL guard is invalid_url, not a retryable network reason", async () => {
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([{ title: "R", url: `${PAGE}/redir`, text: "r" }])],
      [`${PAGE}/redir`, () => new Response(null, {
        status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" },
      })],
    ], []);
    const { executor, cwd } = setup({ fetchImpl });
    const body = parse((await run(executor, cwd, "search_and_read", { query: "astro", depth: 1 })).output);
    expect(body.results[0]).toMatchObject({ id: 1, readError: "invalid_url" });
  });

  test("loopback page URLs stay refused without the private-URL opt-in", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([{ title: "P", url: `${PAGE}/p`, text: "p" }])],
      [`${PAGE}/p`, page("<p>leak</p>")],
    ], calls);
    const { executor, cwd } = setup({ fetchImpl, allowPrivate: false });
    const result = await run(executor, cwd, "search_and_read", { query: "astro", depth: 1 });
    const body = parse(result.output);
    expect(body.results[0]).toMatchObject({ id: 1, readError: "invalid_url" });
    expect(calls.filter((url) => url.startsWith(PAGE))).toHaveLength(0);
  });

  test("degrades to fewer results instead of failing under a tiny ceiling", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      title: `T${index}`, url: `${PAGE}/${index}`, text: "t".repeat(600),
    }));
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search(items)],
      ...items.map((item) => [item.url, page("<p>ok</p>")] as [string, () => Response]),
    ], []);
    const { executor, audit, cwd, tool } = setup({ fetchImpl });
    const tight = { outputLimitTokens: 500 };
    const result = await run(executor, cwd, "search_and_read", { query: "astro", maxResults: 5, depth: 2 }, tight);
    expect(result.isError).not.toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(outputCeilingChars(tool.manifest.output, tight)!);
    const body = parse(result.output);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.length).toBeLessThan(5);
    expect(body.truncated).toBe(true);
    expect(result.truncation).toMatchObject({ unit: "results" });
    expect(audit.readAll().find((item) => item.tipo === "web.read")?.payload).toMatchObject({ truncated: true });
  });

  test("records web.read when the run is already cancelled before the first page", async () => {
    const { tool, audit, cwd } = setup();
    const fake: ToolExecutorLike = {
      audit,
      defs: () => [],
      run: async (_ctx, call) => (call.name === "web_search"
        ? {
          output: JSON.stringify({
            query: "astro", provider: "exa",
            results: [{ id: 1, title: "A", url: `${PAGE}/a`, snippet: "a" }],
          }),
        }
        : { output: "ok" }),
    };
    const result = await tool.execute(
      { query: "astro", depth: 1 },
      { ...ctx(cwd), executor: fake, signal: AbortSignal.abort() },
    );
    expect(result).toMatchObject({ isError: true });
    expect(audit.readAll().find((item) => item.tipo === "web.read")?.payload)
      .toMatchObject({ aborted: true, readCount: 0 });
  });
});

describe("search_and_read allowlist (I-01)", () => {
  test("fails closed when the inner tools are not allowed", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([{ title: "A", url: `${PAGE}/p`, text: "a" }])],
      [`${PAGE}/p`, page("<p>leak</p>")],
    ], calls);
    const { executor, cwd } = setup({ fetchImpl, allow: ["search_and_read"] });
    const result = await run(
      executor, cwd, "search_and_read", { query: "astro", depth: 1 },
      { allow: ["search_and_read"] },
    );
    expect(result).toMatchObject({ isError: true, failure: "denied" });
    expect(calls).toEqual([]);
  });

  test("a nested denied web_fetch becomes invalid_url and never reaches the network", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([{ title: "A", url: `${PAGE}/p`, text: "a" }])],
      [`${PAGE}/p`, page("<p>leak</p>")],
    ], calls);
    const { executor, cwd } = setup({ fetchImpl, allow: ["search_and_read", "web_search"] });
    const result = await run(executor, cwd, "search_and_read", { query: "astro", depth: 1 });
    expect(result.isError).not.toBe(true);
    expect(parse(result.output).results[0]).toMatchObject({ id: 1, readError: "invalid_url" });
    expect(calls.filter((url) => url.startsWith(PAGE))).toHaveLength(0);
  });
});
