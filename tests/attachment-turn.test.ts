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

let base: string;
let cwd: string;
let astroHome: string;
let store: ArtifactStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "astro-att-turn-"));
  cwd = join(base, "work");
  astroHome = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(astroHome, { recursive: true });
  const root = join(base, "artifacts"); // fora do cwd e do ASTRO_HOME
  mkdirSync(root, { recursive: true, mode: 0o700 });
  store = new ArtifactStore(root, { cwd, astroHome, checkPrivate: () => true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function image(name: string, dataBase64: string): LoadedAttachment {
  const bytes = Buffer.from(dataBase64, "base64");
  return {
    kind: "image",
    path: join(cwd, name),
    name,
    sizeBytes: bytes.length,
    mediaType: "image/png",
    data: dataBase64,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
}

function textOf(sizeBytes: number): LoadedAttachment {
  return { kind: "text", path: join(cwd, "t.txt"), name: "t.txt", sizeBytes, mediaType: "text/plain", data: "x" };
}

describe("prepareTurnAttachments (ADR-0026, #392)", () => {
  test("deduplica imagem por hash e conta uma vez no turno", async () => {
    const a = image("a.png", pngData);
    const b = image("b.png", pngData);
    const prepared = await prepareTurnAttachments({ attachments: [a, b], owner: { runId: "r1" }, store, approver: () => true });
    expect(prepared.attachments).toHaveLength(1);
    expect(prepared.images).toHaveLength(1);
  });

  test("teto de 40 MiB do turno vale para texto e imagem juntos", async () => {
    const big = { ...image("a.png", pngData), sizeBytes: MAX_TURN_BYTES };
    await expect(prepareTurnAttachments({ attachments: [big, textOf(1)], owner: { runId: "r1" }, store, approver: () => true }))
      .rejects.toMatchObject({ code: "attachment_turn_too_large" });
  });

  test("sem aprovador imagem é negada (fail closed)", async () => {
    await expect(prepareTurnAttachments({ attachments: [image("a.png", pngData)], owner: { runId: "r1" }, store }))
      .rejects.toMatchObject({ code: "attachment_image_denied" });
  });

  test("rejeição não grava nada no store", async () => {
    await expect(prepareTurnAttachments({ attachments: [image("a.png", pngData)], owner: { runId: "r1" }, store, approver: () => false }))
      .rejects.toMatchObject({ code: "attachment_image_denied" });
    expect(store.usageBytes()).toBe(0);
  });

  test("aprovação grava, preenche ref/hash e audita sem conteúdo", async () => {
    const events: Array<{ tipo: string; payload: Record<string, unknown> }> = [];
    const prepared = await prepareTurnAttachments({
      attachments: [image("a.png", pngData)], owner: { runId: "r1" }, store,
      approver: (items) => { expect(items[0]).toMatchObject({ name: "a.png", pixels: { width: 1, height: 1 } }); return true; },
      audit: (tipo, payload) => events.push({ tipo, payload }),
    });
    expect(prepared.metas[0]).toMatchObject({ kind: "image", mediaType: "image/png" });
    expect(prepared.metas[0]?.ref).toBeString();
    expect(prepared.metas[0]?.hash).toBeString();
    expect(prepared.images[0]).toEqual({ mediaType: "image/png", dataBase64: pngData });
    expect(events).toHaveLength(1);
    expect(events[0]?.tipo).toBe("attachment.approved");
    expect(JSON.stringify(events[0])).not.toContain(pngData);
  });

  test("formatApprovalPrompt lista nome, bytes e MPx", () => {
    const text = formatApprovalPrompt([{ name: "a.png", mediaType: "image/png", sizeBytes: 70, pixels: { width: 1, height: 1 } }]);
    expect(text).toContain("não redigíveis");
    expect(text).toContain("1. a.png - 70 bytes - 1x1 (0.0 MPx)");
  });
});
