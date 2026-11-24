import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { outputCeilingChars } from "../src/tools/contract";
import { createSearchAndReadTool, DEFAULT_DEPTH, MAX_DEPTH, type SearchAndReadDeps } from "../src/tools/web-search-read";

const WEB_SECRET = "web-secret-value";
const SEARCH_BASE = "https://search.test";
const PAGE = "http://127.0.0.1";

let seq = 0;
function setup(overrides: Partial<SearchAndReadDeps> = {}) {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), `astro-search-read-${seq}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const tool = createSearchAndReadTool({
    config: { provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: SEARCH_BASE },
    audit,
    env: { WEB_KEY: WEB_SECRET },
    allowPrivate: true,
    sleep: async () => undefined,
    random: () => 0.5,
    ...overrides,
  });
  return { tool, audit, cwd };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "plan" });

type FetchImpl = NonNullable<SearchAndReadDeps["fetchImpl"]>;

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

type Body = {
  depth: number; untrusted: boolean; provider?: string; truncated?: boolean; notice?: string;
  results: Array<{ id: number; title?: string; url?: string; content?: string; readError?: string }>;
};
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
    const { tool, cwd } = setup({ fetchImpl: routedFetch([], calls) });
    expect(DEFAULT_DEPTH).toBe(3); expect(MAX_DEPTH).toBe(5);
    for (const depth of [0, 6, 1.5, "2"]) {
      expect(await tool.execute({ query: "astro", depth }, ctx(cwd))).toMatchObject({ isError: true, failure: "invalid" });
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
    const { tool, cwd } = setup({ fetchImpl });
    const result = await tool.execute({ query: "astro", depth: 2 }, ctx(cwd));
    expect(result.isError).not.toBe(true);
    const body = parse(result.output);
    expect(body.depth).toBe(2); expect(body.untrusted).toBe(true);
    expect(body.results.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(body.results[0]).toMatchObject({ title: "One", url: `${PAGE}/1` });
    expect(body.results[0]?.content).toContain("body one"); expect(body.results[0]?.content).not.toContain("alert");
    expect(body.results[1]?.content).toBe("body two"); expect(body.results[2]?.content).toBeUndefined();
    expect(calls.filter((url) => url.startsWith(PAGE))).toHaveLength(2);
  });

  test("a page beyond the ceiling is cut, not dropped, and carries the contract marker", async () => {
    const long = "x".repeat(5000);
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([
        { title: "A", url: `${PAGE}/a`, text: "a" },
        { title: "B", url: `${PAGE}/b`, text: "b" },
      ])],
      [`${PAGE}/a`, page(`<p>${long}</p>`)],
      [`${PAGE}/b`, page(`<p>${long}</p>`)],
    ], []);
    const { tool, cwd } = setup({ fetchImpl });
    const tight = { ...ctx(cwd), outputLimitTokens: 500 };
    const result = await tool.execute({ query: "astro", maxResults: 2, depth: 2 }, tight);
    expect(result.isError).not.toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(outputCeilingChars(tool.manifest.output, tight)!);
    const body = parse(result.output);
    expect(body.results.map((item) => item.id)).toEqual([1, 2]);
    expect(body.results.every((item) => typeof item.content === "string")).toBe(true);
    expect(body.truncated).toBe(true); expect(body.notice).toContain("[output truncated:");
    expect(result.truncation).toMatchObject({ unit: "characters" });
    expect(result.truncation?.removed ?? 0).toBeGreaterThan(0);
  });
});

describe("search_and_read cache, fallback and audit (#604)", () => {
  test("reuses the web_search cache and audits without query text, URL host or key", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${SEARCH_BASE}/search`, search([{ title: "A", url: `${PAGE}/p`, text: "trecho" }])],
      [`${PAGE}/p`, page("<p>page</p>")],
    ], calls);
    const { tool, audit, cwd } = setup({ fetchImpl });
    expect((await tool.execute({ query: "astro harness", depth: 1 }, ctx(cwd))).isError).not.toBe(true);
    expect((await tool.execute({ query: "ASTRO   harness", depth: 1 }, ctx(cwd))).isError).not.toBe(true);
    expect(calls.filter((url) => url.startsWith(`${SEARCH_BASE}/search`))).toHaveLength(1);
    const searchEvents = audit.readAll().filter((event) => event.tipo === "web.search");
    expect(searchEvents.map((event) => event.payload?.cacheHit)).toEqual([false, true]);
    const readEvents = audit.readAll().filter((event) => event.tipo === "web.read");
    expect(readEvents[0]?.payload).toMatchObject({ depth: 1, resultsCount: 1, readCount: 1, failedCount: 0 });
    const auditText = JSON.stringify(audit.readAll());
    expect(auditText).not.toContain("astro harness"); expect(auditText).not.toContain("ASTRO");
    expect(auditText).not.toContain("127.0.0.1"); expect(auditText).not.toContain(WEB_SECRET);
  });

  test("moves to the next declared backend like web_search", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch([
      [`${PAGE}/p`, page("<p>ok</p>")],
      ["https://api.search.brave.com", () => Response.json({
        web: { results: [{ title: "B", url: `${PAGE}/p`, description: "trecho" }] },
      })],
    ], calls);
    const { tool, audit, cwd } = setup({
      config: {
        provider: "exa", apiKeyEnv: "WEB_KEY", baseUrl: SEARCH_BASE,
        fallback: [{ provider: "brave", apiKeyEnv: "WEB_KEY" }],
      },
      fetchImpl,
    });
    const result = await tool.execute({ query: "astro", depth: 1 }, ctx(cwd));
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
    const { tool, audit, cwd } = setup({ fetchImpl });
    const result = await tool.execute({ query: "astro" }, ctx(cwd));
    expect(result.isError).not.toBe(true);
    const body = parse(result.output);
    expect(body.depth).toBe(3);
    expect(body.results[0]?.content).toContain("ok");
    expect(body.results[1]).toMatchObject({ id: 2, readError: "http_404" });
    expect(body.results[2]).toMatchObject({ id: 3, readError: "content_type" });
    const readEvent = audit.readAll().find((item) => item.tipo === "web.read");
    expect(readEvent?.payload).toMatchObject({ readCount: 1, failedCount: 2 });
  });
});
