import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Auditor } from "../src/audit";
import type { PermissionMode } from "../src/permissions";
import { ToolExecutor } from "../src/tools/executor";
import { movePathTool } from "../src/tools/move-path";

const dir = () => mkdtempSync(join(tmpdir(), "astro-move-"));
const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "a" });

/** Symlink/junction dentro do cwd apontando para fora; null quando a plataforma recusa criar. */
function escapeLink(cwd: string): string | null {
  const outside = dir();
  writeFileSync(join(outside, "x.txt"), "fora");
  const link = join(cwd, "link");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    return outside;
  } catch {
    return null;
  }
}

describe("move_path (#535)", () => {
  test("manifesto: classe edit, filesystem e parâmetros from/to/overwrite", () => {
    expect(movePathTool.manifest.name).toBe("move_path");
    expect(movePathTool.manifest.class).toBe("edit");
    expect(movePathTool.manifest.sideEffects).toBe("filesystem");
    expect(movePathTool.manifest.idempotent).toBe(false);
    const params = movePathTool.manifest.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty("from");
    expect(params.properties).toHaveProperty("to");
    expect(params.properties).toHaveProperty("overwrite");
    expect(params.required).toEqual(["from", "to"]);
  });

  test("move arquivo e devolve caminho relativo", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "conteudo");
    const result = await movePathTool.execute({ from: "a.txt", to: "b.txt" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("a.txt -> b.txt");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("conteudo");
  });

  test("move diretório com a árvore inteira e cria diretórios de destino", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "src", "nested"), { recursive: true });
    writeFileSync(join(cwd, "src", "nested", "a.txt"), "a");
    const result = await movePathTool.execute({ from: "src", to: "deep/lib" }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(cwd, "src"))).toBe(false);
    expect(readFileSync(join(cwd, "deep", "lib", "nested", "a.txt"), "utf8")).toBe("a");
  });

  test("destino existente sem overwrite é recusado e nada muda", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "novo");
    writeFileSync(join(cwd, "b.txt"), "antigo");
    const result = await movePathTool.execute({ from: "a.txt", to: "b.txt" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("já existe");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("antigo");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("novo");
  });

  test("overwrite: true substitui arquivo de destino", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "novo");
    writeFileSync(join(cwd, "b.txt"), "antigo");
    const result = await movePathTool.execute({ from: "a.txt", to: "b.txt", overwrite: true }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("novo");
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
  });

  test("overwrite não substitui diretório (§ I-11: sem remoção implícita de árvore)", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "a"));
    mkdirSync(join(cwd, "b"));
    writeFileSync(join(cwd, "b", "keep.txt"), "keep");
    const result = await movePathTool.execute({ from: "a", to: "b", overwrite: true }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("diretório");
    expect(readFileSync(join(cwd, "b", "keep.txt"), "utf8")).toBe("keep");
  });

  test("recusa destino com .. e path absoluto", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    for (const to of ["../escape.txt", resolve(cwd, "..", "escape.txt"), join(cwd, "inside.txt")]) {
      const result = await movePathTool.execute({ from: "a.txt", to }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/fora do diretório|absoluto/);
    }
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
  });

  test("recusa origem fora do cwd e symlink que escapa (I-11)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "ok.txt"), "x");
    expect((await movePathTool.execute({ from: "../ok.txt", to: "y.txt" }, ctx(cwd))).isError).toBe(true);
    const outside = escapeLink(cwd);
    if (outside === null) return; // plataforma sem symlink: coberto pelo caso de `..`
    for (const from of ["link/x.txt", "link"]) {
      const escaped = await movePathTool.execute({ from, to: "moved" }, ctx(cwd));
      expect(escaped.isError).toBe(true);
      expect(escaped.output).toContain("fora do diretório");
    }
    expect(existsSync(join(cwd, "moved"))).toBe(false);
    expect(readFileSync(join(outside, "x.txt"), "utf8")).toBe("fora");
  });

  test("recusa no-op e diretório de trabalho como origem", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    const noop = await movePathTool.execute({ from: "a.txt", to: "a.txt" }, ctx(cwd));
    expect(noop.isError).toBe(true);
    expect(noop.output).toContain("mesmo caminho");
    const root = await movePathTool.execute({ from: ".", to: "outro" }, ctx(cwd));
    expect(root.isError).toBe(true);
    expect(root.output).toContain("diretório de trabalho");
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
  });

  test("recusa mover .astro (hard-block) e diretório para dentro de si", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, ".astro"));
    writeFileSync(join(cwd, ".astro", "audit.jsonl"), "{}");
    const reserved = await movePathTool.execute({ from: ".astro", to: "state" }, ctx(cwd));
    expect(reserved.isError).toBe(true);
    expect(reserved.output).toContain("reservado");
    expect(existsSync(join(cwd, ".astro", "audit.jsonl"))).toBe(true);

    mkdirSync(join(cwd, "src"));
    const nested = await movePathTool.execute({ from: "src", to: "src/nested" }, ctx(cwd));
    expect(nested.isError).toBe(true);
    expect(nested.output).toContain("própria origem");
    expect(existsSync(join(cwd, "src"))).toBe(true);
  });

  test("origem inexistente e input inválido devolvem erro tipado", async () => {
    const cwd = dir();
    expect((await movePathTool.execute({ from: "ghost.txt", to: "b.txt" }, ctx(cwd))).isError).toBe(true);
    expect((await movePathTool.execute({ from: "", to: "b.txt" }, ctx(cwd))).isError).toBe(true);
    expect((await movePathTool.execute({ from: "a.txt" }, ctx(cwd))).isError).toBe(true);
    expect((await movePathTool.execute("texto", ctx(cwd))).isError).toBe(true);
  });

  test("matriz de aprovação: ask pede, allow-edits e bypass não pedem (classe edit)", async () => {
    const run = async (mode: PermissionMode) => {
      const cwd = dir();
      writeFileSync(join(cwd, "a.txt"), "x");
      let asked = 0;
      const executor = new ToolExecutor({
        tools: [movePathTool],
        allow: ["move_path"],
        audit: new Auditor(join(cwd, "audit.jsonl")),
        permissionMode: mode,
        approveTool: () => {
          asked++;
          return true;
        },
      });
      const result = await executor.run(ctx(cwd), {
        id: "c1",
        name: "move_path",
        arguments: JSON.stringify({ from: "a.txt", to: "b.txt" }),
      });
      return { asked, result, moved: existsSync(join(cwd, "b.txt")) };
    };
    const ask = await run("ask");
    expect(ask).toMatchObject({ asked: 1, moved: true });
    expect(ask.result.isError).toBeFalsy();
    const allowEdits = await run("allow-edits");
    expect(allowEdits).toMatchObject({ asked: 0, moved: true });
    const bypass = await run("bypass");
    expect(bypass).toMatchObject({ asked: 0, moved: true });
  });

  test("overwrite: true pede aprovação em allow-edits (destrutivo, review B1)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "novo");
    writeFileSync(join(cwd, "b.txt"), "antigo");
    let asked = 0;
    const executor = new ToolExecutor({
      tools: [movePathTool],
      allow: ["move_path"],
      audit: new Auditor(join(cwd, "audit.jsonl")),
      permissionMode: "allow-edits",
      approveTool: () => {
        asked++;
        return true;
      },
    });
    const result = await executor.run(ctx(cwd), {
      id: "c1",
      name: "move_path",
      arguments: JSON.stringify({ from: "a.txt", to: "b.txt", overwrite: true }),
    });
    expect(asked).toBe(1);
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("novo");
  });

  test("overwrite: true guarda o destino em .bak antes de substituir (review B1)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "novo");
    writeFileSync(join(cwd, "b.txt"), "antigo");
    const result = await movePathTool.execute({ from: "a.txt", to: "b.txt", overwrite: true }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(".bak");
    const backups = readdirSync(cwd).filter((name) => name.startsWith("b.txt.") && name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(cwd, backups[0] as string), "utf8")).toBe("antigo");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("novo");
  });

  test("junction como origem não pode ir para dentro do próprio alvo (review B2)", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "keep.txt"), "x");
    try {
      symlinkSync(join(cwd, "src"), join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // plataforma sem link: caso coberto pelo teste de diretório real
    }
    const result = await movePathTool.execute({ from: "link", to: "link/sub" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("própria origem");
    expect(readFileSync(join(cwd, "src", "keep.txt"), "utf8")).toBe("x");
  });

  test("allow-critical não autoriza mover hard-block (decisão: só leitura/escrita pontual)", async () => {
    const cwd = dir();
    // Nome crítico *configurável*: o allow-critical do gate libera, a tool não obedece.
    const critical = join(cwd, "db-password.txt");
    writeFileSync(critical, "valor-sintetico\n");
    const result = await movePathTool.execute(
      { from: "db-password.txt", to: "x.txt" },
      { ...ctx(cwd), allowCritical: [critical] },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("hard-block");
    expect(existsSync(critical)).toBe(true);
  });

  test("tool.call registra os paths (redigidos) para a classe edit (review)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    const auditPath = join(cwd, "audit.jsonl");
    const executor = new ToolExecutor({
      tools: [movePathTool],
      allow: ["move_path"],
      audit: new Auditor(auditPath),
      permissionMode: "bypass",
    });
    await executor.run(ctx(cwd), {
      id: "c1",
      name: "move_path",
      arguments: JSON.stringify({ from: "a.txt", to: "b.txt" }),
    });
    const events = readFileSync(auditPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { tipo: string; payload: Record<string, unknown> });
    expect(events.find((event) => event.tipo === "tool.call")?.payload)
      .toMatchObject({ name: "move_path", paths: ["a.txt", "b.txt"] });
    // par auditado (I-04): a chamada e o resultado, sem conteúdo
    expect(events.find((event) => event.tipo === "tool.result")?.payload)
      .toMatchObject({ name: "move_path", isError: false });
  });

  test("recusa mover árvore com .env e deixa tudo intacto (review B3)", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "app"));
    writeFileSync(join(cwd, "app", ".env"), "CHAVE=sintetica\n");
    writeFileSync(join(cwd, "app", "notes.txt"), "x");
    const result = await movePathTool.execute({ from: "app", to: "public" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("hard-block");
    expect(existsSync(join(cwd, "app", ".env"))).toBe(true);
    expect(existsSync(join(cwd, "app", "notes.txt"))).toBe(true);
    expect(existsSync(join(cwd, "public"))).toBe(false);
  });

  test("recusa mover árvore que contém protectedPaths relativo ao cwd (review B3)", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "app"));
    writeFileSync(join(cwd, "app", "keep.json"), "{}");
    writeFileSync(join(cwd, "app", "notes.txt"), "x");
    const result = await movePathTool.execute(
      { from: "app", to: "public" },
      { ...ctx(cwd), protectedPaths: ["app/keep.json"] },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("hard-block");
    expect(existsSync(join(cwd, "app", "keep.json"))).toBe(true);
    expect(existsSync(join(cwd, "public"))).toBe(false);
  });

  test("destino que já é diretório com hard-block é recusado e intacto (review B3)", async () => {
    const cwd = dir();
    mkdirSync(join(cwd, "app"));
    writeFileSync(join(cwd, "app", "notes.txt"), "x");
    mkdirSync(join(cwd, "public"));
    writeFileSync(join(cwd, "public", ".env"), "CHAVE=sintetica\n");
    const result = await movePathTool.execute({ from: "app", to: "public" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(existsSync(join(cwd, "public", ".env"))).toBe(true);
    expect(existsSync(join(cwd, "app", "notes.txt"))).toBe(true);
  });

  test("destino sob diretório hard-block é recusado (review B3)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    mkdirSync(join(cwd, "keys"));
    const result = await movePathTool.execute({ from: "a.txt", to: "keys/novo.txt" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("hard-block");
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    expect(existsSync(join(cwd, "keys", "novo.txt"))).toBe(false);
  });

  test("erro de FS não ecoa o texto cru do SO e cita só o caminho relativo (review B4)", async () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.txt"), "x");
    writeFileSync(join(cwd, "blob"), "sou um arquivo");
    const result = await movePathTool.execute({ from: "a.txt", to: "blob/x.txt" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("atravessa um arquivo");
    expect(result.output).toContain("blob/x.txt");
    expect(result.output).not.toContain(cwd); // nada de path absoluto do SO
    expect(result.output).not.toContain("EEXIST");
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
  });
});
