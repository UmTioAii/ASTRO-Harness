import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TURN_BYTES, type LoadedAttachment } from "../src/attachments/model";
import { ArtifactStore } from "../src/attachments/store";
import { formatApprovalPrompt, prepareTurnAttachments } from "../src/attachments/turn";

/** PNG 1x1 real (70 bytes): assinatura + IHDR com width=1 e height=1. */
const pngData =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const owner = { runId: "r1" };

let base: string;
let cwd: string;
let store: ArtifactStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "astro-att-turn-"));
  cwd = join(base, "work");
  const astroHome = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(astroHome, { recursive: true });
  const root = join(base, "artifacts"); // fora do cwd e do ASTRO_HOME
  mkdirSync(root, { recursive: true, mode: 0o700 });
  store = new ArtifactStore(root, { cwd, astroHome, checkPrivate: () => true });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function image(name: string, dataBase64: string): LoadedAttachment {
  const bytes = Buffer.from(dataBase64, "base64");
  return { kind: "image", path: join(cwd, name), name, sizeBytes: bytes.length,
    mediaType: "image/png", data: dataBase64, hash: createHash("sha256").update(bytes).digest("hex") };
}

function textOf(sizeBytes: number): LoadedAttachment {
  return { kind: "text", path: join(cwd, "t.txt"), name: "t.txt", sizeBytes, mediaType: "text/plain", data: "x" };
}

describe("prepareTurnAttachments (ADR-0026, #392)", () => {
  test("deduplica imagem por hash, preserva a primeira e conta uma vez no turno", async () => {
    const prepared = await prepareTurnAttachments({ attachments: [image("a.png", pngData), image("b.png", pngData)], owner, store, approver: () => true });
    expect(prepared.images).toHaveLength(1);
    expect(prepared.metas).toHaveLength(1);
    expect(prepared.metas[0]?.name).toBe("a.png");
    expect(prepared.metas[0]).not.toHaveProperty("data");
  });

  test("teto de 40 MiB do turno vale para texto e imagem juntos", async () => {
    const big = { ...image("a.png", pngData), sizeBytes: MAX_TURN_BYTES };
    await expect(prepareTurnAttachments({ attachments: [big, textOf(1)], owner, store, approver: () => true }))
      .rejects.toMatchObject({ code: "attachment_turn_too_large" });
  });

  test("imagem sem aprovação é negada (fail closed) e não grava", async () => {
    await expect(prepareTurnAttachments({ attachments: [image("a.png", pngData)], owner, store }))
      .rejects.toMatchObject({ code: "attachment_image_denied" });
    await expect(prepareTurnAttachments({ attachments: [image("a.png", pngData)], owner, store, approver: () => false }))
      .rejects.toMatchObject({ code: "attachment_image_denied" });
    expect(store.usageBytes()).toBe(0);
  });

  test("imagem aprovada sem store falha e não grava", async () => {
    await expect(prepareTurnAttachments({ attachments: [image("a.png", pngData)], owner, approver: () => true }))
      .rejects.toMatchObject({ code: "attachment_root_invalid" });
    expect(store.usageBytes()).toBe(0);
  });

  test("aprovação grava, preenche ref/hash e audita sem conteúdo", async () => {
    const events: Array<{ tipo: string; payload: Record<string, unknown> }> = [];
    let prompt = "";
    const prepared = await prepareTurnAttachments({
      attachments: [image("a.png", pngData)], owner, store,
      approver: (items) => {
        prompt = formatApprovalPrompt(items);
        expect(items[0]).toMatchObject({ name: "a.png", pixels: { width: 1, height: 1 } });
        return true;
      },
      audit: (tipo, payload) => events.push({ tipo, payload }),
    });
    expect(prompt).toContain("a.png");
    expect(prompt).not.toContain(pngData);
    expect(prepared.metas[0]).toMatchObject({ kind: "image", mediaType: "image/png" });
    expect(prepared.metas[0]?.ref).toBeString();
    expect(prepared.metas[0]?.hash).toBeString();
    expect(prepared.images[0]).toEqual({ mediaType: "image/png", dataBase64: pngData });
    expect(events).toHaveLength(1);
    expect(events[0]?.tipo).toBe("attachment.approved");
    expect(JSON.stringify(events[0])).not.toContain(pngData);
  });

  test("formatApprovalPrompt mostra path, sanitiza controle e mantém nome sem path", () => {
    const text = formatApprovalPrompt([
      { name: "a.png", path: "/x/um/a.png", mediaType: "image/png", sizeBytes: 70, pixels: { width: 1, height: 1 } },
      { name: "só-nome.png", mediaType: "image/png", sizeBytes: 70 },
      { name: "mal\nicioso\u001b[31m.png", mediaType: "image/png", sizeBytes: 70 },
    ]);
    expect(text).toContain("1. /x/um/a.png - 70 bytes - 1x1 (0.0 MPx)");
    expect(text).toContain("2. só-nome.png - 70 bytes - dimensão desconhecida");
    expect(text.split("\n")).toHaveLength(4); // título + 3 itens: `\n` no nome não forja linha
    expect(text).not.toContain("mal\nicioso");
    expect(text).not.toContain("\u001b");
  });
});
