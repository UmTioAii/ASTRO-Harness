import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool } from "../src/tools/read-file";
import type { ToolContext } from "../src/tools/types";

function workspace(content: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-read-page-"));
  writeFileSync(join(cwd, "file.txt"), content);
  return cwd;
}

const numbered = (count: number, text = (index: number) => `linha ${index}`): string =>
  Array.from({ length: count }, (_, index) => text(index + 1)).join("\n") + "\n";

const ctx = (cwd: string, outputLimitTokens?: number) => ({
  cwd, run: "r1", agent: "coder", ...(outputLimitTokens === undefined ? {} : { outputLimitTokens }),
});

const body = (output: string): string[] => output.split("\n").slice(1);

describe("read_file paginado (S-16, CMP-11)", () => {
  test("primeira página: 350 linhas, sem offset, com próximo offset (overlap 10)", async () => {
    const cwd = workspace(numbered(1000));
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 8000));
    const lines = result.output.split("\n");

    expect(result.isError).toBeFalsy();
    expect(lines[0]).toBe("linhas 1-350 de 1000; para continuar, offset 341");
    expect(lines[1]).toBe("linha 1");
    expect(lines[350]).toBe("linha 350");
    expect(lines).toHaveLength(351);
  });

  test("página intermediária usa o offset pedido e repete 10 linhas no overlap", async () => {
    const cwd = workspace(numbered(1000));
    const result = await readFileTool.execute({ path: "file.txt", offset: 341 }, ctx(cwd, 8000));
    const lines = result.output.split("\n");

    expect(lines[0]).toBe("linhas 341-690 de 1000; para continuar, offset 681");
    expect(lines[1]).toBe("linha 341");
    expect(lines[350]).toBe("linha 690");
    expect(lines[11]).toBe("linha 351");
  });

  test("última página não anuncia continuação", async () => {
    const cwd = workspace(numbered(1000));
    const result = await readFileTool.execute({ path: "file.txt", offset: 691 }, ctx(cwd, 8000));
    const lines = result.output.split("\n");

    expect(lines[0]).toBe("linhas 691-1000 de 1000");
    expect(lines).not.toContain("para continuar");
    expect(lines[1]).toBe("linha 691");
    expect(lines.at(-1)).toBe("linha 1000");
  });

  test("arquivo menor que uma página devolve tudo, sem cabeçalho de continuação", async () => {
    const cwd = workspace(numbered(10));
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 8000));
    expect(result.output).toBe(`linhas 1-10 de 10\n${numbered(10)}`.trimEnd());
  });

  test("arquivo vazio devolve página vazia; CRLF e sem newline final contam linhas corretamente", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-read-edge-"));
    writeFileSync(join(cwd, "empty.txt"), "");
    const empty = await readFileTool.execute({ path: "empty.txt" }, ctx(cwd, 8000));
    expect(empty.output).toBe("linhas 0-0 de 0");

    writeFileSync(join(cwd, "crlf.txt"), "a\r\nb\r\n");
    expect((await readFileTool.execute({ path: "crlf.txt" }, ctx(cwd, 8000))).output)
      .toBe("linhas 1-2 de 2\na\nb");

    writeFileSync(join(cwd, "no-final.txt"), "a\nb");
    expect((await readFileTool.execute({ path: "no-final.txt" }, ctx(cwd, 8000))).output)
      .toBe("linhas 1-2 de 2\na\nb");
  });

  test("offset além do total devolve fim do arquivo sem erro", async () => {
    const cwd = workspace(numbered(10));
    const result = await readFileTool.execute({ path: "file.txt", offset: 11 }, ctx(cwd, 8000));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("fim do arquivo");
    expect(result.output).toContain("10 linhas");
  });

  test("offset inválido falha", async () => {
    const cwd = workspace(numbered(10));
    for (const offset of [0, -1, 1.5]) {
      const result = await readFileTool.execute({ path: "file.txt", offset }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("offset");
    }
  });

  test("página acima do cap encolhe em passos de 50 linhas", async () => {
    const cwd = workspace(numbered(400, (index) => `linha ${index} ${"x".repeat(5000)}`));
    // cap 200 tokens = 800 chars: nem 50 linhas cabem, mas o passo mínimo é 50.
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 200));
    const lines = result.output.split("\n");
    const header = lines[0]!;

    expect(header).toMatch(/^linhas 1-(\d+) de 400/);
    const end = Number(/^linhas 1-(\d+)/.exec(header)![1]);
    expect(end).toBeLessThanOrEqual(50);
    expect(body(result.output).filter((line) => line.startsWith("linha ")).length).toBe(end);
  });

  // Segredo sintético construído em runtime (gate G6: sem literal de segredo no diff).
  const READ_SECRET = ["s", "k", "-"].join("") + "slice3a-read-synthetic-5d6e7f" + "q".repeat(160);

  test("redige antes de paginar: cap conta o texto redigido, não o cru (ADR-0027, I-03)", async () => {
    // 400 linhas longas por causa do segredo: cruas, 350 linhas estouram o cap;
    // redigidas, a página cheia cabe inteira.
    const content = Array.from({ length: 400 }, (_, i) => `linha ${i + 1} token=${READ_SECRET}`).join("\n") + "\n";
    const cwd = workspace(content);
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 3000));
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain(READ_SECRET);
    expect(result.output).toContain("[REDACTED]");
    expect(result.output.split("\n")[0]).toBe("linhas 1-350 de 400; para continuar, offset 341");
  });

  test("redige o arquivo inteiro antes de paginar: bloco na borda da página não vaza (ADR-0027)", async () => {
    // PEM montado em runtime para não expor literal no diff (gate G6).
    const pemBegin = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const pemEnd = ["-----END", "PRIVATE KEY-----"].join(" ");
    const pemBody = "MII" + "B".repeat(60);
    const lines = [
      ...Array.from({ length: 348 }, (_, i) => `linha ${i + 1}`),
      pemBegin,
      pemBody,
      pemEnd,
      ...Array.from({ length: 50 }, (_, i) => `depois ${i + 1}`),
    ];
    const cwd = workspace(lines.join("\n") + "\n");
    const result = await readFileTool.execute({ path: "file.txt" }, ctx(cwd, 8000));
    expect(result.isError).toBeFalsy();
    // A página 1 termina no meio do bloco: sem redação prévia, o corpo vazaria.
    expect(result.output).not.toContain(pemBody);
    expect(result.output).toContain("[REDACTED]");
  });
});

// ADR-0027 slice 3b (#391): gate de entropia só no tier `sensitive`.
const dir3b = () => mkdtempSync(join(tmpdir(), "astro-read3b-"));
const ctxEnv = (cwd: string, env: Record<string, string> = {}): ToolContext => ({
  cwd, run: "r1", agent: "default", env,
});

/** base64 sintética gerada em runtime (gate G6: sem literal de segredo no diff). */
const randomBase64 = (chars: number): string =>
  randomBytes(Math.ceil((chars * 3) / 4)).toString("base64").slice(0, chars);

/** Segredo sintético construído em runtime (gate G6: sem literal no diff). */
const SYNTH_3B = ["s", "k", "-"].join("") + "sintetico-teste-3b-0000000000aabbccddeeff";

const readEnv = (cwd: string, path: string, env?: Record<string, string>) =>
  readFileTool.execute({ path }, ctxEnv(cwd, env));

describe("read_file — gate de entropia no tier sensitive (ADR-0027, #391 slice 3b)", () => {
  test("normal não aplica entropia: conteúdo aleatório é lido", async () => {
    const cwd = dir3b();
    const blob = randomBase64(4096);
    writeFileSync(join(cwd, "notes.txt"), blob);
    const r = await readEnv(cwd, "notes.txt");
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain(blob.slice(0, 64));
  });

  test("sensitive com entropia alta é negado, citando path e classe, sem conteúdo", async () => {
    const cwd = dir3b();
    const blob = randomBase64(4096);
    writeFileSync(join(cwd, ".env.example"), blob);
    const r = await readEnv(cwd, ".env.example");
    expect(r.isError).toBe(true);
    expect(r.output).toContain(".env.example");
    expect(r.output).toContain("sensitive");
    expect(r.output).not.toContain(blob.slice(0, 64));
  });

  test("sensitive com entropia baixa é permitido e segue redigido antes de paginar", async () => {
    const cwd = dir3b();
    const low = `API_TOKEN=${SYNTH_3B}\n` + "FOO=bar\nBAZ=qux\n".repeat(200);
    writeFileSync(join(cwd, "config.sample"), low);
    const r = await readEnv(cwd, "config.sample");
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("[REDACTED]");
    expect(r.output).not.toContain(SYNTH_3B);
  });

  test("sensitive ilegível (diretório) é inconclusivo: nega fail-closed", async () => {
    const cwd = dir3b();
    mkdirSync(join(cwd, "pasta.example"));
    const r = await readEnv(cwd, "pasta.example");
    expect(r.isError).toBe(true);
    expect(r.output).toContain("sensitive");
    expect(r.output).toContain("pasta.example");
  });

  test("limiar via env ASTRO_ENTROPY_THRESHOLD alto permite conteúdo ~6 bits/char", async () => {
    const cwd = dir3b();
    writeFileSync(join(cwd, ".env.example"), randomBase64(4096));
    const r = await readEnv(cwd, ".env.example", { ASTRO_ENTROPY_THRESHOLD: "7.5" });
    expect(r.isError).toBeFalsy();
  });

  test("limiar via env baixo nega conteúdo de entropia média (1 bit/char)", async () => {
    const cwd = dir3b();
    writeFileSync(join(cwd, "dados.template"), "ab".repeat(500));
    const r = await readEnv(cwd, "dados.template", { ASTRO_ENTROPY_THRESHOLD: "0.5" });
    expect(r.isError).toBe(true);
    expect(r.output).toContain("sensitive");
  });

  test("limiar inválido via env falha fechado (nega mesmo conteúdo de entropia baixa)", async () => {
    const cwd = dir3b();
    writeFileSync(join(cwd, ".env.example"), "FOO=bar\n".repeat(100));
    for (const bad of ["banana", "0", "-1", "99"]) {
      const r = await readEnv(cwd, ".env.example", { ASTRO_ENTROPY_THRESHOLD: bad });
      expect(r.isError).toBe(true);
      expect(r.output).toContain("sensitive");
    }
  });

  test("paginação continua valendo em sensitive permitido", async () => {
    const cwd = dir3b();
    const lines = Array.from({ length: 400 }, (_, i) => `linha ${i + 1} FOO=bar`);
    writeFileSync(join(cwd, "grande.dist"), `${lines.join("\n")}\n`);
    const r = await readEnv(cwd, "grande.dist");
    expect(r.isError).toBeFalsy();
    expect(r.output.startsWith("linhas 1-350 de 400; para continuar, offset 341")).toBe(true);
    expect(r.output).toContain("linha 350 FOO=bar");
    expect(r.output).not.toContain("linha 351 FOO=bar");
    const r2 = await readFileTool.execute({ path: "grande.dist", offset: 351 }, ctxEnv(cwd));
    expect(r2.isError).toBeFalsy();
    expect(r2.output.startsWith("linhas 351-400 de 400")).toBe(true);
  });
});
