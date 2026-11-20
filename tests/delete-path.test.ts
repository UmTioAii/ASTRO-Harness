import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auditor } from "../src/audit";
import { PATH_HARD_BLOCKED, type PermissionMode } from "../src/permissions";
import { deletePathTool } from "../src/tools/delete-path";
import { ToolExecutor } from "../src/tools/executor";

const dir = () => mkdtempSync(join(tmpdir(), "astro-delete-"));
const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "a" });

function escapeLink(cwd: string): string | null {
  const outside = dir();
  writeFileSync(join(outside, "x.txt"), "fora");
  try {
    symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    return outside;
  } catch {
    return null;
  }
}

describe("delete_path (#535)", () => {
  test("manifesto: classe delete, filesystem e parâmetros path/recursive", () => {
    expect(deletePathTool.manifest.name).toBe("delete_path");
    // `delete` (não `edit`): a MATRIX mantém `ask` em allow-edits e só libera em bypass.
    expect(deletePathTool.manifest.class).toBe("delete");
    expect(deletePathTool.manifest.sideEffects).toBe("filesystem");
    const params = deletePathTool.manifest.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("recursive");
    expect(params.required).toEqual(["path"]);
  });

  test("remove arquivo e devolve caminho relativo", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    const result = await deletePathTool.execute({ path: "a.txt" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("a.txt");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
  });

  test("diretório sem recursive é recusado e a árvore fica intacta", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "tree", "nested"), { recursive: true });
    writeFileSync(join(cwd, "tree", "nested", "a.txt"), "x");
    const result = await deletePathTool.execute({ path: "tree" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("recursive: true");
    expect(existsSync(join(cwd, "tree", "nested", "a.txt"))).toBe(true);
  });

  test("diretório com recursive: true é removido por inteiro", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "tree", "nested"), { recursive: true });
    writeFileSync(join(cwd, "tree", "nested", "a.txt"), "x");
    const result = await deletePathTool.execute({ path: "tree", recursive: true }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(cwd, "tree"))).toBe(false);
  });

  test("recusa ., o cwd, .. e path absoluto", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    for (const path of [".", "./", "../fora.txt", resolve(cwd), join(cwd, "a.txt")]) {
      const result = await deletePathTool.execute({ path }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/diretório de trabalho|fora do diretório|absoluto/);
    }
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
  });

  test("symlink que escapa do cwd é recusado (I-11)", async () => {
    const cwd = dir();
    const outside = escapeLink(cwd);
    if (outside === null) return;
    const result = await deletePathTool.execute({ path: "link" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("fora do diretório");
    expect(existsSync(join(outside, "x.txt"))).toBe(true);
  });

  test(".astro/ e protectedPaths continuam reservados", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".astro"));
    writeFileSync(join(cwd, ".astro", "audit.jsonl"), "{}");
    writeFileSync(join(cwd, "keep.json"), "{}");
    const state = await deletePathTool.execute({ path: ".astro/audit.jsonl" }, ctx(cwd));
    expect(state.isError).toBe(true);
    expect(state.output).toContain("reservado");
    expect(existsSync(join(cwd, ".astro", "audit.jsonl"))).toBe(true);

    const protectedPath = await deletePathTool.execute(
      { path: "keep.json" },
      { ...ctx(cwd), protectedPaths: [join(cwd, "keep.json")] },
    );
    expect(protectedPath.isError).toBe(true);
    expect(protectedPath.output).toContain("reservado");
    expect(existsSync(join(cwd, "keep.json"))).toBe(true);
  });

  test("recursive é recusado quando a árvore contém hard-block/protected", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "project", "src"), { recursive: true });
    writeFileSync(join(cwd, "project", "src", "a.txt"), "x");
    writeFileSync(join(cwd, "project", ".env"), "CHAVE=sintetica\n");
    const result = await deletePathTool.execute({ path: "project", recursive: true }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("hard-block");
    expect(existsSync(join(cwd, "project", ".env"))).toBe(true);
    expect(existsSync(join(cwd, "project", "src", "a.txt"))).toBe(true);
  });

  test("hard-block vence a MATRIX no dispatch, mesmo em bypass (ADR-0027)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, ".env"), "CHAVE=sintetica\n");
    const executor = new ToolExecutor({
      tools: [deletePathTool],
      allow: ["delete_path"],
      audit: new Auditor(join(cwd, "audit.jsonl")),
      permissionMode: "bypass",
    });
    const result = await executor.run(ctx(cwd), {
      id: "c1",
      name: "delete_path",
      arguments: JSON.stringify({ path: ".env" }),
    });
    expect(result.isError).toBe(true);
    expect(result.code).toBe(PATH_HARD_BLOCKED);
    expect(existsSync(join(cwd, ".env"))).toBe(true);
  });

  test("matriz de aprovação: ask pede, allow-edits continua pedindo, bypass não pede", async () => {
    const run = async (mode: PermissionMode) => {
      const cwd = dir();
      writeFileSync(join(cwd, "a.txt"), "x");
      let asked = 0;
      const executor = new ToolExecutor({
        tools: [deletePathTool],
        allow: ["delete_path"],
        audit: new Auditor(join(cwd, "audit.jsonl")),
        permissionMode: mode,
        approveTool: () => {
          asked++;
          return true;
        },
      });
      const result = await executor.run(ctx(cwd), {
        id: "c1",
        name: "delete_path",
        arguments: JSON.stringify({ path: "a.txt" }),
      });
      return { asked, result, deleted: !existsSync(join(cwd, "a.txt")) };
    };
    expect(await run("ask")).toMatchObject({ asked: 1, deleted: true });
    expect(await run("allow-edits")).toMatchObject({ asked: 1, deleted: true });
    expect(await run("bypass")).toMatchObject({ asked: 0, deleted: true });
  });
});
