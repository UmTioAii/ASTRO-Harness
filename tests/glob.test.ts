import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../src/tools/glob";

interface GlobOutput {
  files: string[];
  total: number;
  truncated: boolean;
  notice?: string;
}

function output(result: { output: string }): GlobOutput {
  return JSON.parse(result.output) as GlobOutput;
}

function setupTree(): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-glob-"));
  mkdirSync(join(cwd, "src", "tools"), { recursive: true });
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "root.ts"), "");
  writeFileSync(join(cwd, "src", "app.ts"), "");
  writeFileSync(join(cwd, "src", "tools", "glob.ts"), "");
  writeFileSync(join(cwd, "docs", "guia.md"), "");
  return cwd;
}

/** Link de diretório (junction no Windows): cobre escape por link sem exigir privilégio de symlink. */
function canCreateDirSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "astro-glob-symlink-probe-"));
  try {
    mkdirSync(join(dir, "alvo"));
    symlinkSync(join(dir, "alvo"), join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINK_SUPPORTED = canCreateDirSymlink();

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

describe("glob tool (#534, F-13)", () => {
  test("manifesto: read-only, read_common, sem efeitos", () => {
    expect(globTool.manifest.name).toBe("glob");
    expect(globTool.manifest.risk).toBe("low");
    expect(globTool.manifest.permission).toBe("read");
    expect(globTool.manifest.class).toBe("read_common");
    expect(globTool.manifest.sideEffects).toBe("none");
    expect(globTool.manifest.retryable).toBe(true);
    expect(globTool.manifest.idempotent).toBe(true);
    const params = globTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("pattern");
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("includeIgnored");
    expect(params.required).toEqual(["pattern"]);
  });

  test("árvore aninhada: caminhos relativos, posix e ordenados", async () => {
    const cwd = setupTree();
    const result = await globTool.execute({ pattern: "**/*.ts" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const parsed = output(result);
    expect(parsed.files).toEqual(["root.ts", "src/app.ts", "src/tools/glob.ts"]);
    expect(parsed.files).toEqual([...parsed.files].sort());
    expect(parsed.files.every((file) => !file.includes("\\"))).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.truncated).toBe(false);
    expect(parsed.notice).toBeUndefined();
  });

  test("path restringe a busca ao subdiretório", async () => {
    const cwd = setupTree();
    const result = await globTool.execute({ pattern: "**/*.ts", path: "src" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(output(result).files).toEqual(["src/app.ts", "src/tools/glob.ts"]);
  });

  test("cap de 500 com aviso explícito e truncated: true", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-glob-cap-"));
    mkdirSync(join(cwd, "many"), { recursive: true });
    // Margem sobre o cap: o teste prova o corte, não a borda exata.
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(cwd, "many", `f${String(i).padStart(3, "0")}.txt`), "");
    }
    const result = await globTool.execute({ pattern: "many/*.txt" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const parsed = output(result);
    expect(typeof parsed.truncated).toBe("boolean");
    expect(parsed.files).toHaveLength(500);
    expect(parsed.files[0]).toBe("many/f000.txt");
    expect(parsed.files.at(-1)).toBe("many/f499.txt");
    expect(parsed.total).toBe(600);
    expect(parsed.truncated).toBe(true);
    expect(parsed.notice).toBeDefined();
    expect(parsed.notice).toContain("truncad");
    expect(parsed.notice).toContain("500");
  }, 60_000);

  test(".git e node_modules ficam fora por default e entram com includeIgnored", async () => {
    const cwd = setupTree();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, ".git", "config"), "");
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "");

    const excluded = output(await globTool.execute({ pattern: "**/*" }, ctx(cwd)));
    expect(excluded.files).not.toContain(".git/config");
    expect(excluded.files).not.toContain("node_modules/pkg/index.js");
    expect(excluded.files).toContain("src/app.ts");

    const included = output(await globTool.execute({ pattern: "**/*", includeIgnored: true }, ctx(cwd)));
    expect(included.files).toContain(".git/config");
    expect(included.files).toContain("node_modules/pkg/index.js");
  });

  test("entradas fora do cwd são recusadas: absoluto e `..` (I-11)", async () => {
    const cwd = setupTree();
    const refused: Array<{ input: Record<string, unknown>; message: string }> = [
      { input: { pattern: join(cwd, "**", "*.ts") }, message: "absoluto" }, // absoluto nativo do SO
      { input: { pattern: "/etc/**" }, message: "absoluto" },
      { input: { pattern: "C:\\Windows\\**" }, message: "absoluto" }, // `isAbsolute` é false no POSIX
      { input: { pattern: "C:foo" }, message: "absoluto" }, // drive relativo
      { input: { pattern: "\\\\server\\share\\**" }, message: "absoluto" }, // UNC
      { input: { pattern: "\\src\\*.ts" }, message: "absoluto" }, // barra invertida inicial
      { input: { pattern: "../**/*.ts" }, message: "fora" },
      { input: { pattern: ".." }, message: "fora" },
      { input: { pattern: "src/../../*.ts" }, message: "fora" },
      { input: { pattern: "**/*.ts", path: ".." }, message: "fora" },
    ];
    for (const { input, message } of refused) {
      const result = await globTool.execute(input, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toContain(message);
    }
  });

  test.skipIf(!SYMLINK_SUPPORTED)("link para fora do cwd não é seguido", async () => {
    const cwd = setupTree();
    const outside = mkdtempSync(join(tmpdir(), "astro-glob-outside-"));
    try {
      writeFileSync(join(outside, "fora.txt"), "conteudo externo");
      symlinkSync(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");

      const parsed = output(await globTool.execute({ pattern: "**/*" }, ctx(cwd)));
      expect(parsed.files).not.toContain("escape/fora.txt");
      expect(parsed.files).not.toContain("escape");
      expect(parsed.files).toContain("root.ts");

      // Prefixo literal atravessando o link também não alcança o alvo.
      for (const pattern of ["escape/**", "escape/fora.txt"]) {
        const result = await globTool.execute({ pattern }, ctx(cwd));
        expect(result.isError).toBe(true);
        expect(result.output).toContain("fora");
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("normaliza `./`, `\\`, `/` final e `literal/..` antes do matcher (#573 review A)", async () => {
    const cwd = setupTree();
    const cases: Array<[string, string[]]> = [
      ["./src/*.ts", ["src/app.ts"]],
      ["src\\tools\\*.ts", ["src/tools/glob.ts"]],
      ["src/../docs/*.md", ["docs/guia.md"]],
      ["**/", ["docs/guia.md", "root.ts", "src/app.ts", "src/tools/glob.ts"]],
    ];
    for (const [pattern, expected] of cases) {
      const result = await globTool.execute({ pattern }, ctx(cwd));
      expect(result.isError).toBeFalsy();
      expect(output(result).files).toEqual(expected);
    }
  });

  test("ordena entre diretórios irmãos", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-glob-sort-"));
    mkdirSync(join(cwd, "m"));
    mkdirSync(join(cwd, "a"));
    writeFileSync(join(cwd, "m", "x.ts"), "");
    writeFileSync(join(cwd, "a", "y.ts"), "");
    const parsed = output(await globTool.execute({ pattern: "**/*.ts" }, ctx(cwd)));
    expect(parsed.files).toEqual(["a/y.ts", "m/x.ts"]);
  });

  test("`path` excluído por padrão também exige includeIgnored (#573 review A)", async () => {
    const cwd = setupTree();
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, ".git", "config"), "");
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "");

    // Nem por `path` nem pelo prefixo literal do padrão o diretório excluído entra.
    for (const ignored of [".git", "node_modules"]) {
      for (const input of [
        { pattern: "**/*", path: ignored },
        { pattern: `${ignored}/**` },
      ]) {
        const refused = await globTool.execute(input, ctx(cwd));
        expect(refused.isError).toBe(true);
        expect(refused.output).toContain("includeIgnored");
      }
    }

    const viaPath = output(await globTool.execute(
      { pattern: "**/*", path: ".git", includeIgnored: true }, ctx(cwd),
    ));
    expect(viaPath.files).toEqual([".git/config"]);
    const viaPattern = output(await globTool.execute({ pattern: ".git/**", includeIgnored: true }, ctx(cwd)));
    expect(viaPattern.files).toEqual([".git/config"]);
  });

  test("arquivo com nome de diretório excluído também fica fora (worktree tem `.git` arquivo)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-glob-gitfile-"));
    writeFileSync(join(cwd, ".git"), "gitdir: /fora\n");
    writeFileSync(join(cwd, "a.ts"), "");
    expect(output(await globTool.execute({ pattern: "**" }, ctx(cwd))).files).toEqual(["a.ts"]);
    expect(output(await globTool.execute({ pattern: "**", includeIgnored: true }, ctx(cwd))).files)
      .toEqual([".git", "a.ts"]);
  });

  test("orçamento de saída: caminhos longos não estouram o cap do executor (#573 review A)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-glob-budget-"));
    const deep = join(cwd, ...Array.from({ length: 6 }, (_, i) => `pacote-${i}-com-nome-longo`));
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(deep, `arquivo-${String(i).padStart(2, "0")}-sufixo-longo.ts`), "");
    }
    const result = await globTool.execute({ pattern: "**/*.ts" }, { ...ctx(cwd), outputLimitTokens: 200 });
    expect(result.isError).toBeFalsy();
    const parsed = output(result);
    expect(parsed.total).toBe(40);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.files.length).toBeLessThan(40);
    expect(parsed.truncated).toBe(true);
    expect(parsed.notice).toContain(`${parsed.files.length} de 40`);
    // O JSON inteiro, com notice, cabe no cap de 200 tokens (4 chars/token).
    expect(Math.ceil(result.output.length / 4)).toBeLessThanOrEqual(200);
  });

  test("sem resultado devolve lista vazia; entrada inválida vira erro", async () => {
    const cwd = setupTree();
    const empty = output(await globTool.execute({ pattern: "**/*.rs" }, ctx(cwd)));
    expect(empty).toEqual({ files: [], total: 0, truncated: false });

    for (const input of [{}, { pattern: "" }, null]) {
      const result = await globTool.execute(input, ctx(cwd));
      expect(result.isError).toBe(true);
    }
  });
});
