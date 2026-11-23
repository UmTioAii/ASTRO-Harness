import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirTool, entryCost } from "../src/tools/list-dir";
import { outputCeilingChars } from "../src/tools/contract";

interface DirNode {
  name: string;
  type: "file" | "dir";
  children?: DirNode[];
}

function setupNested(levels: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-"));
  let current = cwd;
  for (let i = 0; i < levels; i++) {
    const dirName = `level${i}`;
    const fileName = `file${i}.txt`;
    writeFileSync(join(current, fileName), `content ${i}`);
    mkdirSync(join(current, dirName));
    current = join(current, dirName);
  }
  writeFileSync(join(current, "leaf.txt"), "leaf");
  return cwd;
}

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

describe("list_dir tool (F4-2)", () => {
  test("manifesto correto", () => {
    expect(listDirTool.manifest.name).toBe("list_dir");
    expect(listDirTool.manifest.risk).toBe("low");
    expect(listDirTool.manifest.permission).toBe("read");
    expect(listDirTool.manifest.timeoutMs).toBe(10_000);
    expect(listDirTool.manifest.retryable).toBe(true);
    const params = listDirTool.manifest.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("depth");
    expect(params.required).toHaveLength(0);
  });

  test("lista árvore com arquivos e diretórios", async () => {
    const cwd = setupNested(2);
    const result = await listDirTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    expect(tree.type).toBe("dir");
    expect(tree.children).toBeDefined();
    const names = tree.children!.map((c) => c.name);
    expect(names).toContain("file0.txt");
    expect(names).toContain("level0");
    const level0 = tree.children!.find((c) => c.name === "level0")!;
    expect(level0.type).toBe("dir");
    expect(level0.children).toBeDefined();
  });

  test("default depth 3: para no nível 3", async () => {
    const cwd = setupNested(6);
    const result = await listDirTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;

    // Percorre até profundidade 3; level2 (3º nível) não deve ter children
    const level0 = tree.children!.find((c) => c.name === "level0")!;
    const level1 = level0.children!.find((c) => c.name === "level1")!;
    const level2 = level1.children!.find((c) => c.name === "level2")!;
    // depth 3 significa que desce 3 níveis: raiz(0) → level0(1) → level1(2) → level2(3, sem children)
    expect(level2.children).toBeUndefined();
  });

  test("depth customizado respeita maxDepth=1", async () => {
    const cwd = setupNested(3);
    const result = await listDirTool.execute({ depth: 1 }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    const level0 = tree.children!.find((c) => c.name === "level0")!;
    // depth 1: só o primeiro nível de children, sem children de children
    expect(level0.children).toBeUndefined();
  });

  test("depth máximo 10: valores acima clampam", async () => {
    const cwd = setupNested(3);
    const result = await listDirTool.execute({ depth: 50 }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    let depth = 0;
    let node: DirNode | undefined = tree;
    while (node?.children !== undefined) {
      depth++;
      node = node.children[0];
    }
    expect(depth).toBeLessThanOrEqual(10);
  });

  test("lista 5 níveis sem estouro de stack", async () => {
    const cwd = setupNested(5);
    const result = await listDirTool.execute({ depth: 5 }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    // Percorre 5 níveis
    let node: DirNode | undefined = tree.children!.find((c) => c.name === "level0");
    for (let i = 1; i < 5; i++) {
      expect(node).toBeDefined();
      node = node!.children?.find((c) => c.name === `level${i}`);
    }
    expect(node).toBeDefined();
  });

  test("path relativo restringe busca", async () => {
    const cwd = setupNested(2);
    const result = await listDirTool.execute({ path: "level0" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode;
    expect(tree.name).toBe("level0");
    expect(tree.children!.map((c) => c.name)).toContain("file1.txt");
    expect(tree.children!.map((c) => c.name)).not.toContain("file0.txt");
  });

  test("caminho fora do cwd → denied, sem ecoar o caminho (I-11)", async () => {
    const cwd = setupNested(1);
    const result = await listDirTool.execute({ path: "../" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.failure).toBe("denied");
    expect(result.output).toBe("path outside the working directory");
    expect(result.output).not.toContain(cwd);
  });

  test("path inexistente → erro claro", async () => {
    const cwd = setupNested(1);
    const result = await listDirTool.execute({ path: "ghost" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("does not exist");
    writeFileSync(join(cwd, "plain.txt"), "x");
    const notDir = await listDirTool.execute({ path: "plain.txt" }, ctx(cwd));
    expect(notDir.isError).toBe(true);
    expect(notDir.output).toContain("not a directory");
  });
});

describe("list_dir output contract (S6, #603)", () => {
  // Synthetic secret built at runtime (gate G6: no secret literal in the diff).
  const SECRET = ["s", "k", "-"].join("") + "listdir-synthetic-778899aabb";

  test("declares an output ceiling", () => {
    const ceiling = listDirTool.manifest.output;
    expect(ceiling).toBeDefined();
    expect(ceiling!.maxTokens).toBe(4000);
    expect(ceiling!.hint.length).toBeGreaterThan(0);
    // A larger session cap never raises the declared ceiling.
    expect(outputCeilingChars(ceiling, { outputLimitTokens: 100_000 })).toBe(4000 * 4);
  });

  test("a directory-heavy tree stays inside the declared ceiling", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-dirs-"));
    for (let i = 0; i < 700; i++) mkdirSync(join(cwd, `dir-${String(i).padStart(4, "0")}`));
    const result = await listDirTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode & { truncated?: boolean };
    expect(tree.truncated).toBe(true);
    // A directory serializes wider than a file (`children`), so the charge must match it.
    expect(result.output.length).toBeLessThanOrEqual(4000 * 4);
    expect(tree.children!.length + result.truncation!.removed).toBe(700);
    expect(result.truncation!.total).toBe(700);
  });

  test("emitted order is code-unit based, not locale dependent", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-order-"));
    for (const name of ["a.txt", "B.txt", "c.txt"]) writeFileSync(join(cwd, name), "x");
    const tree = JSON.parse((await listDirTool.execute({}, ctx(cwd))).output) as DirNode;
    expect(tree.children!.map((c) => c.name)).toEqual(["B.txt", "a.txt", "c.txt"]);
  });

  test("the entry charge matches the serialized node, escapes included", () => {
    // A name with quotes/backslashes serializes wider than its raw length.
    expect(entryCost('a"b\\c', "file")).toBe(JSON.stringify({ name: 'a"b\\c', type: "file" }).length + 1);
    expect(entryCost("plain", "dir")).toBe(JSON.stringify({ name: "plain", type: "dir", children: [] }).length + 1);
    expect(entryCost('a"b\\c', "file")).toBeGreaterThan('a"b\\c'.length + 26);
  });

  test("tree above the ceiling is cut with an explicit marker and a structured field", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-cap-"));
    mkdirSync(join(cwd, "many"));
    for (let i = 0; i < 500; i++) {
      writeFileSync(join(cwd, "many", `file-${String(i).padStart(4, "0")}-${"x".repeat(40)}.txt`), "x");
    }
    const result = await listDirTool.execute({ path: "many" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    const tree = JSON.parse(result.output) as DirNode & { truncated?: boolean; notice?: string };
    expect(tree.truncated).toBe(true);
    expect(tree.notice).toContain("omitted");
    expect(result.truncation).toBeDefined();
    // Exact: every one of the 500 entries is either listed or counted as omitted.
    expect(tree.children!.length + result.truncation!.removed).toBe(500);
    expect(result.truncation!.total).toBe(500);
    expect(result.output.length).toBeLessThanOrEqual(16_000);
  });

  test("a secret in a name is redacted before it reaches the result (I-03)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-secret-"));
    writeFileSync(join(cwd, SECRET), "x");
    const result = await listDirTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain(SECRET);
    expect(result.output).toContain("[REDACTED]");
  });

  test("a secret in a directory name is redacted at root and nested (I-03)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-secret-dir-"));
    mkdirSync(join(cwd, "outer", SECRET), { recursive: true });
    writeFileSync(join(cwd, "outer", SECRET, "inner.txt"), "x");

    // Nested node: the directory is emitted as a child with its own name.
    const tree = await listDirTool.execute({}, ctx(cwd));
    expect(tree.isError).toBeFalsy();
    expect(tree.output).not.toContain(SECRET);
    expect(tree.output).toContain("[REDACTED]");

    // Root node: the caller points at the directory itself.
    const root = await listDirTool.execute({ path: `outer/${SECRET}` }, ctx(cwd));
    expect(root.isError).toBeFalsy();
    expect(root.output).not.toContain(SECRET);
    expect(root.output).toContain("[REDACTED]");
  });

  test("cut landing on a directory reports the exact number of hidden entries", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-listdir-count-"));
    mkdirSync(join(cwd, "alpha"));
    writeFileSync(join(cwd, "alpha", "a.txt"), "x");
    mkdirSync(join(cwd, "beta", "sub"), { recursive: true });
    writeFileSync(join(cwd, "beta", "b1.txt"), "x");
    writeFileSync(join(cwd, "beta", "b2.txt"), "x");
    writeFileSync(join(cwd, "beta", "sub", "b3.txt"), "x");

    // 20 tokens -> 64-char budget: only alpha fits, so the cut lands on a directory.
    const result = await listDirTool.execute({}, { ...ctx(cwd), outputLimitTokens: 20 });
    expect((JSON.parse(result.output) as { truncated?: boolean }).truncated).toBe(true);
    // kept: alpha. omitted: a.txt, beta, b1, b2, sub, b3.
    expect(result.truncation).toEqual({ removed: 6, total: 7, unit: "entries", hint: listDirTool.manifest.output!.hint });
    expect(result.output).toContain("6 of 7 entries omitted");
    // Recorded decision (#621): the 64-char floor plus the additive marker make a
    // tiny session cap (20 tokens = 80 chars) produce a slightly larger output.
    expect(result.output.length).toBeGreaterThan(80);
  });

  test("failure taxonomy: escape is denied, missing path failed", async () => {
    const cwd = setupNested(1);
    const escape = await listDirTool.execute({ path: "../" }, ctx(cwd));
    expect(escape.isError).toBe(true);
    expect(escape.failure).toBe("denied");
    const missing = await listDirTool.execute({ path: "ghost" }, ctx(cwd));
    expect(missing.isError).toBe(true);
    expect(missing.failure).toBe("failed");
  });

  test("a non-policy resolution error is failed, not denied", async () => {
    const cwd = setupNested(1);
    // A null byte makes realpath throw a TypeError (not a confinement refusal).
    const result = await listDirTool.execute({ path: "\0" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.failure).toBe("failed");
    expect(result.output).not.toContain(cwd);
  });

  test("a missing absolute path is not echoed (I-03)", async () => {
    const cwd = setupNested(1);
    const result = await listDirTool.execute({ path: join(cwd, "ghost") }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain(cwd);
  });
});