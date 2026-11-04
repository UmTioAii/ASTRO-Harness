import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { createWebFetchTool, type WebFetchDeps } from "../src/tools/web-fetch";

const HOST_SECRET = ["s", "k", "-"].join("") + "host-secret-123456";

beforeAll(() => { process.env.ASTRO_ALLOW_PRIVATE_URLS = "1"; });
afterAll(() => { delete process.env.ASTRO_ALLOW_PRIVATE_URLS; });

let seq = 0;
function setup(overrides: Partial<WebFetchDeps> = {}) {
  seq += 1;
  const cwd = mkdtempSync(join(tmpdir(), `astro-web-fetch-${seq}-`));
  const audit = new Auditor(join(cwd, "audit.jsonl"));
  const tool = createWebFetchTool({ audit, ...overrides });
  return { tool, audit, cwd };
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "plan" });

describe("web_fetch manifest e validação (#57)", () => {
  test("manifesto: risk low, permission read, timeout 15s e network", () => {
    const { tool } = setup();
    expect(tool.manifest.name).toBe("web_fetch");
    expect(tool.manifest.risk).toBe("low");
    expect(tool.manifest.permission).toBe("read");
    expect(tool.manifest.timeoutMs).toBe(15000);
    expect(tool.manifest.sideEffects).toBe("network");
    expect(tool.manifest.description.toLowerCase()).toContain("untrusted");
  });

  test("recusa URL inválida, maxLength fora do limite e format desconhecido", async () => {
    const { tool, cwd } = setup();
    expect(await tool.execute({ url: "file:///etc/passwd" }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ url: "https://example.test", maxLength: 0 }, ctx(cwd))).toMatchObject({ isError: true });
    expect(await tool.execute({ url: "https://example.test", format: "html" }, ctx(cwd))).toMatchObject({ isError: true });
  });
});

describe("web_fetch sanitização (#57)", () => {
  const page = `<!doctype html><html><head><style>body{color:red}</style><script>alert(1)</script></head>
<body onload="x()"><h1>Título</h1><p onclick="evil()">Olá <b>mundo</b> &amp; cia</p>
<ul><li>um</li><li>dois</li></ul>
<iframe src="https://evil.test"></iframe><noscript>sem js</noscript>
&lt;script&gt;alert(2)&lt;/script&gt;<base href="https://evil.test/">
<a href="https://ok.test/path">link</a><a href="javascript:alert(1)">perigo</a>
<a href="javascript&#58;alert(3)">ent</a><a href="java&#10;script:alert(4)">nl</a>
<img src="x" onerror="alert(1)"></body></html>`;

  test("markdown remove script/style/iframe/handlers e preserva estrutura", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    try {
      const { tool, cwd } = setup();
      const result = await tool.execute({ url: `${server.url.origin}/` }, ctx(cwd));
      expect(result.isError).not.toBe(true);
      expect(result.output).toContain("# Título");
      expect(result.output).toContain("[link](https://ok.test/path)");
      expect(result.output).toContain("- um");
      expect(result.output).toContain("Olá **mundo** & cia");
      expect(result.output).not.toContain("alert(1)");
      expect(result.output).not.toContain("alert(2)");
      expect(result.output).not.toContain("alert(3)");
      expect(result.output).not.toContain("alert(4)");
      expect(result.output).not.toContain("<script");
      expect(result.output).not.toContain("<iframe");
      expect(result.output).not.toContain("onclick");
      expect(result.output).not.toContain("javascript:");
      expect(result.output).not.toContain("evil.test");
      expect(result.output).not.toContain("sem js");
    } finally {
      server.stop(true);
    }
  });

  test("format text remove marcação e mantém o texto dos links", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("<h2>Oi</h2><a href='https://ok.test'>link</a>", { headers: { "content-type": "text/html" } }),
    });
    try {
      const { tool, cwd } = setup();
      const result = await tool.execute({ url: `${server.url.origin}/`, format: "text" }, ctx(cwd));
      expect(result.output).toContain("Oi");
      expect(result.output).toContain("link");
      expect(result.output).not.toContain("[link]");
      expect(result.output).not.toContain("<h2>");
    } finally {
      server.stop(true);
    }
  });

  test("maxLength trunca a saída", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("x".repeat(200), { headers: { "content-type": "text/plain" } }),
    });
    try {
      const { tool, cwd } = setup();
      const result = await tool.execute({ url: `${server.url.origin}/`, maxLength: 50 }, ctx(cwd));
      expect(result.output.length).toBeLessThanOrEqual(50);
    } finally {
      server.stop(true);
    }
  });

  test("sem Content-Type trata como HTML e sanitiza", async () => {
    const { tool, cwd } = setup({
      fetchImpl: async () => {
        const response = new Response("<script>alert(1)</script><p>ok</p>");
        response.headers.delete("content-type");
        return response;
      },
    });
    const result = await tool.execute({ url: "http://127.0.0.1/" }, ctx(cwd));
    expect(result.output).toContain("ok");
    expect(result.output).not.toContain("alert");
    expect(result.output).not.toContain("<script");
  });
});

describe("web_fetch audit e limites (#57)", () => {
  test("audita url/status/contentLength/duration sem vazar segredo do host", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    });
    try {
      const { tool, audit, cwd } = setup();
      const result = await tool.execute({ url: `${server.url.origin}/doc?q=astro&page=1` }, ctx(cwd));
      expect(result.isError).not.toBe(true);
      const event = audit.readAll().find((item) => item.tipo === "web.fetch");
      expect(event?.payload).toMatchObject({ status: 200, contentLength: 2 });
      const audited = String((event?.payload as { url?: string }).url);
      expect(audited).toContain("/doc");
      expect(audited).not.toContain("q=");
      expect(audited).not.toContain("page=");
    } finally {
      server.stop(true);
    }
  });

  test("recusa host privado literal sem opt-in", async () => {
    const previous = process.env.ASTRO_ALLOW_PRIVATE_URLS;
    delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
    try {
      const { tool, cwd } = setup();
      const result = await tool.execute({ url: "http://localhost.:1234/" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/privado|recusada/);
    } finally {
      if (previous === undefined) delete process.env.ASTRO_ALLOW_PRIVATE_URLS;
      else process.env.ASTRO_ALLOW_PRIVATE_URLS = previous;
    }
  });

  test("não segue redirect para host de metadados", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    });
    try {
      const { tool, cwd } = setup();
      const result = await tool.execute({ url: `${server.url.origin}/` }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/metadados|link-local/);
    } finally {
      server.stop(true);
    }
  });

  test("recusa conteúdo não textual e status não-2xx", async () => {
    const pdf = Bun.serve({
      port: 0,
      fetch: () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
    });
    const missing = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    try {
      const { tool, cwd } = setup();
      expect(await tool.execute({ url: `${pdf.url.origin}/` }, ctx(cwd))).toMatchObject({ isError: true });
      expect(await tool.execute({ url: `${missing.url.origin}/` }, ctx(cwd))).toMatchObject({ isError: true });
    } finally {
      pdf.stop(true);
      missing.stop(true);
    }
  });
});
