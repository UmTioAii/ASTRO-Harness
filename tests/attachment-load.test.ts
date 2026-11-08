import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAttachment, loadPastedText } from "../src/attachments/load";

const roots: string[] = [];

function sandbox(): { cwd: string; astroHome: string } {
  const root = mkdtempSync(join(tmpdir(), "astro-att-"));
  roots.push(root);
  const cwd = join(root, "work");
  const astroHome = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(astroHome);
  return { cwd, astroHome };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base = (cwd: string, astroHome: string) => ({ cwd, astroHome });

describe("loadAttachment", () => {
  test("texto: conteúdo, tamanho UTF-8 e redação", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "linha1\nlinha2\nlinha3\n");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt" });
    expect(attachment.kind).toBe("text");
    expect(attachment.mediaType).toBe("text/plain");
    expect(attachment.data).toContain("linha2");
    expect(attachment.sizeBytes).toBe(Buffer.byteLength(attachment.data, "utf8"));
  });

  test("segredo é redigido antes de virar payload", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "chave sk-abcdefghijklmnop123456 aqui");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt" });
    expect(attachment.data).not.toContain("sk-abcdefghijklmnop123456");
    expect(attachment.data).toContain("[REDACTED]");
  });

  test("range 2:3 devolve só essas linhas", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\ntres\n");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt", range: "2:3" });
    expect(attachment.data).toBe("dois\ntres");
    expect(attachment.range).toEqual({ start: 2, end: 3 });
  });

  test("hard-block em .env sem override", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, ".env"), "KEY=1");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: ".env" })).rejects.toMatchObject({
      code: "attachment_hard_blocked",
    });
  });

  test("fora do cwd pede confirmação; negado para", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "..", "outside.txt"), "x");
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "../outside.txt", confirmOutsideCwd: () => false }),
    ).rejects.toMatchObject({ code: "attachment_outside_denied" });
    const ok = await loadAttachment({
      ...base(cwd, astroHome),
      path: "../outside.txt",
      confirmOutsideCwd: () => true,
    });
    expect(ok.kind).toBe("text");
  });

  test("sem confirmOutsideCwd fora do cwd falha fechado", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "..", "outside2.txt"), "x");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "../outside2.txt" })).rejects.toMatchObject({
      code: "attachment_outside_denied",
    });
  });

  test("diretório lista e rejeita acima de 500 entradas", async () => {
    const { cwd, astroHome } = sandbox();
    mkdirSync(join(cwd, "dir"));
    for (let index = 0; index < 3; index++) writeFileSync(join(cwd, "dir", `f${index}.txt`), "x");
    const attachment = await loadAttachment({ ...base(cwd, astroHome), path: "dir" });
    expect(attachment.kind).toBe("directory");
    expect(attachment.mediaType).toBe("inode/directory");
    expect(attachment.data.split("\n")).toHaveLength(3);
    const big = join(cwd, "big");
    mkdirSync(big);
    for (let index = 0; index < 501; index++) writeFileSync(join(big, `f${index}.txt`), "");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "big" })).rejects.toMatchObject({
      code: "attachment_directory_too_large",
    });
  });

  test("diretório omite ocultos sem showHidden", async () => {
    const { cwd, astroHome } = sandbox();
    mkdirSync(join(cwd, "d"));
    writeFileSync(join(cwd, "d", "visivel.txt"), "x");
    writeFileSync(join(cwd, "d", ".oculto"), "x");
    const sem = await loadAttachment({ ...base(cwd, astroHome), path: "d" });
    expect(sem.data).toContain("visivel.txt");
    expect(sem.data).not.toContain(".oculto");
    const com = await loadAttachment({ ...base(cwd, astroHome), path: "d", showHidden: true });
    expect(com.data).toContain(".oculto");
  });

  test("0 byte texto ok; binário rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "empty.txt"), "");
    expect((await loadAttachment({ ...base(cwd, astroHome), path: "empty.txt" })).sizeBytes).toBe(0);
    writeFileSync(join(cwd, "bin"), Buffer.from([0, 1, 2]));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "bin" })).rejects.toMatchObject({
      code: "attachment_unsupported_binary",
    });
  });

  test("imagem com header ilegível rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "i.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "i.png" })).rejects.toMatchObject({
      code: "attachment_image_invalid",
    });
  });

  test("arquivo maior que o teto rejeita sem ler", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "grande.txt"), Buffer.alloc(64));
    await expect(
      loadAttachment({ ...base(cwd, astroHome), path: "grande.txt", maxBytes: 16 }),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
  });
});

describe("loadPastedText", () => {
  test("texto vira anexo com hash e sem path", () => {
    const attachment = loadPastedText("colado");
    expect(attachment.kind).toBe("text");
    expect(attachment.path).toBeUndefined();
    expect(attachment.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment.sizeBytes).toBe(Buffer.byteLength("colado", "utf8"));
  });
});
