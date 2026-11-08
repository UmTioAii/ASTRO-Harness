# Anexos — fatia 1 (núcleo, paths e limites) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** entregar o núcleo puro de anexos (modelo, magic bytes, limites, range, dedupe), a validação de header de imagem e o carregamento de path com hard-block/confirmação, sem UI.

**Architecture:** dois módulos novos em `src/attachments/` — `model.ts` (puro) e `load.ts` (I/O) — mais a seção `attachments` em `src/config.ts`. `load.ts` reusa `classifyPath` (ADR-0027) com `artifactRoot: null`, porque a raiz de artefato é destino, nunca fonte.

**Tech Stack:** Bun + TypeScript strict, `bun test`, sem dependência nova.

**Spec:** `docs/superpowers/specs/2026-11-08-anexos-attachments-design.md`

## Global Constraints

- Limites: 20 MiB/anexo, 40 MiB/turno, 500 entradas de diretório, 25 MPx, 8192 px no lado maior, 20 MiB decodificados.
- `kind` por magic bytes, nunca por extensão; SVG é texto.
- Texto passa por `redactSecrets` antes de entrar no prompt.
- Hard-block sem override; fora do cwd exige confirmação; sem TTY nega e para.
- Mensagem de erro cita caminho, nunca conteúdo (I-03).
- TDD: RED antes de GREEN, commits separados.

## Review Focus

- Arquivo de 0 byte: texto aceita, imagem rejeita.
- Header truncado (menos bytes que a assinatura): falha fechado, sem exceção crua.
- `..`/symlink que escapa do cwd: confirmação, não bloqueio separado.
- Range além do total de linhas: erro tipado, não leitura parcial silenciosa.
- Diretório com 501 entradas: erro tipado, sem listagem truncada.

---

### Task 1: modelo puro

**Files:**
- Create: `src/attachments/model.ts`
- Test: `tests/attachment-model.test.ts`

**Interfaces:**
- Produces: `AttachmentKind`, `AttachmentRange`, `Attachment`, `AttachmentMeta`, `LoadedAttachment`, `DetectedKind`, `AttachmentErrorCode`, `AttachmentError`, `MAX_ATTACHMENT_BYTES`, `MAX_TURN_BYTES`, `MAX_DIRECTORY_ENTRIES`, `MAX_IMAGE_PIXELS`, `MAX_IMAGE_SIDE`, `detectKind(header: Uint8Array): DetectedKind | null`, `parseRange(spec: string, totalLines: number): AttachmentRange`, `dedupeKey(attachment: Pick<Attachment,"kind"|"path"|"range"|"hash">): string`, `assertAttachmentSize(sizeBytes: number, name: string): void`, `assertTurnSize(attachments: readonly Pick<Attachment, "sizeBytes">[]): void`.

- [ ] **Step 1: escrever o teste que falha**

```ts
// tests/attachment-model.test.ts
import { describe, expect, test } from "bun:test";
import {
  AttachmentError, MAX_ATTACHMENT_BYTES, MAX_TURN_BYTES,
  assertAttachmentSize, assertTurnSize, dedupeKey, detectKind, parseRange,
} from "../src/attachments/model";

const bytes = (...parts: number[]) => Uint8Array.from(parts);

describe("detectKind", () => {
  test("reconhece PNG, JPEG, GIF e WEBP por assinatura", () => {
    expect(detectKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ kind: "image", mediaType: "image/png" });
    expect(detectKind(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({ kind: "image", mediaType: "image/jpeg" });
    expect(detectKind(new TextEncoder().encode("GIF89a"))).toEqual({ kind: "image", mediaType: "image/gif" });
    expect(detectKind(new TextEncoder().encode("RIFF....WEBPVP8 "))).toEqual({ kind: "image", mediaType: "image/webp" });
  });
  test("texto UTF-8 sem NUL é text/plain; SVG é texto", () => {
    expect(detectKind(new TextEncoder().encode("olá, mundo"))).toEqual({ kind: "text", mediaType: "text/plain" });
    expect(detectKind(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toEqual({ kind: "text", mediaType: "text/plain" });
  });
  test("binário e UTF-8 inválido retornam null", () => {
    expect(detectKind(bytes(0x00, 0x01, 0x02))).toBeNull();
    expect(detectKind(bytes(0xff, 0xfe, 0x00))).toBeNull();
  });
  test("header truncado falha fechado", () => {
    expect(detectKind(bytes(0x89, 0x50))).toBeNull();
  });
});

describe("parseRange", () => {
  test("1-based inclusivo", () => {
    expect(parseRange("10:40", 100)).toEqual({ start: 10, end: 40 });
    expect(parseRange("10", 100)).toEqual({ start: 10, end: 10 });
  });
  test("inválido lança attachment_range_invalid", () => {
    for (const spec of ["0:5", "5:3", "1:101", "a:b", ":"]) {
      expect(() => parseRange(spec, 100)).toThrow(AttachmentError);
      try { parseRange(spec, 100); } catch (error) { expect((error as AttachmentError).code).toBe("attachment_range_invalid"); }
    }
  });
});

describe("dedupeKey", () => {
  test("texto usa path+range; imagem usa hash", () => {
    expect(dedupeKey({ kind: "text", path: "/a", range: { start: 1, end: 2 } })).toBe("text:/a:1-2");
    expect(dedupeKey({ kind: "image", hash: "abc" })).toBe("image:abc");
  });
});

describe("limites", () => {
  test("20 MiB por anexo", () => {
    expect(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES, "a")).not.toThrow();
    expect(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES + 1, "a")).toThrow(AttachmentError);
  });
  test("40 MiB por turno", () => {
    const ok = [{ sizeBytes: MAX_TURN_BYTES - 1 }, { sizeBytes: 1 }];
    expect(() => assertTurnSize(ok)).not.toThrow();
    expect(() => assertTurnSize([...ok, { sizeBytes: 1 }])).toThrow(AttachmentError);
  });
});
```

- [ ] **Step 2: rodar e ver falhar**

Run: `bun test tests/attachment-model.test.ts`
Expected: FAIL — módulo `../src/attachments/model` não existe.

- [ ] **Step 3: implementar `src/attachments/model.ts`**

Tipos e constantes exatamente como no spec. `detectKind`: assinatura PNG/JPEG/GIF/WEBP; senão tenta `new TextDecoder("utf-8", { fatal: true }).decode(header)` e rejeita se contiver `\u0000`; `null` para binário ou header curto. `parseRange`: regex `^(\d+)(?::(\d+))?$`, ambos ≥ 1, `end ≥ start`, `end ≤ totalLines`; senão `AttachmentError("attachment_range_invalid", ...)`. `dedupeKey`: `text:<path>:<start>-<end>`, `directory:<path>`, `image:<hash>`, `text:clipboard:<hash>` quando não há path.

- [ ] **Step 4: rodar e ver passar**

Run: `bun test tests/attachment-model.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add src/attachments/model.ts tests/attachment-model.test.ts
git commit -m "test: cover attachment model, magic bytes and limits" # RED primeiro, depois:
git commit -m "feat: add attachment model, magic bytes and limits"
```

---

### Task 2: header de imagem

**Files:**
- Modify: `src/attachments/model.ts`
- Test: `tests/attachment-image-header.test.ts`

**Interfaces:**
- Produces: `imageDimensions(header: Uint8Array, mediaType: string): { width: number; height: number } | null`, `assertImageLimits(header: Uint8Array, mediaType: string, decodedBytes: number): void`.

- [ ] **Step 1: escrever o teste que falha**

```ts
// tests/attachment-image-header.test.ts
import { describe, expect, test } from "bun:test";
import { AttachmentError, MAX_IMAGE_PIXELS, assertImageLimits, imageDimensions } from "../src/attachments/model";

const u8 = (...p: number[]) => Uint8Array.from(p);
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(10); b.set(new TextEncoder().encode("GIF89a"));
  b[6] = w & 0xff; b[7] = w >> 8; b[8] = h & 0xff; b[9] = h >> 8; return b;
}
function jpeg(w: number, h: number): Uint8Array {
  return u8(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
}

describe("imageDimensions", () => {
  test("PNG, GIF e JPEG", () => {
    expect(imageDimensions(png(1, 1), "image/png")).toEqual({ width: 1, height: 1 });
    expect(imageDimensions(gif(10, 20), "image/gif")).toEqual({ width: 10, height: 20 });
    expect(imageDimensions(jpeg(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });
  test("header truncado ou SOF ausente retorna null", () => {
    expect(imageDimensions(png(1, 1).slice(0, 12), "image/png")).toBeNull();
    expect(imageDimensions(u8(0xff, 0xd8, 0xff), "image/jpeg")).toBeNull();
  });
});

describe("assertImageLimits", () => {
  test("aceita dentro dos limites", () => expect(() => assertImageLimits(png(100, 100), "image/png", 1024)).not.toThrow());
  test("rejeita acima de 25 MPx", () => {
    expect(() => assertImageLimits(png(5000, 5001), "image/png", 1024)).toThrow(AttachmentError);
  });
  test("rejeita lado maior que 8192", () => {
    expect(() => assertImageLimits(png(9000, 1), "image/png", 1024)).toThrow(AttachmentError);
  });
  test("rejeita decodificado acima de 20 MiB", () => {
    expect(() => assertImageLimits(png(1, 1), "image/png", 20 * 1024 * 1024 + 1)).toThrow(AttachmentError);
  });
  test("dimensões ilegíveis falham fechado", () => {
    expect(() => assertImageLimits(u8(0x89, 0x50), "image/png", 1)).toThrow(AttachmentError);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — `bun test tests/attachment-image-header.test.ts` → FAIL.

- [ ] **Step 3: implementar**

PNG: `DataView.getUint32(16)`/`(20)` com header ≥ 24. GIF: little-endian em 6..10. JPEG: varrer marcadores `0xFF`, parar em SOF0–SOF15 exceto C4/C8/CC, ler altura/largura big-endian. WEBP: `VP8X` (24..30, 24 bits LE + 1), `VP8L` (bits 14/14 em 21..25), `VP8` (start code `9d 01 2a` em 23..26, largura/altura 14 bits LE). `assertImageLimits` lança `attachment_image_invalid` se `imageDimensions` for `null`, `attachment_image_invalid` para MPx/lado/bytes acima do limite.

- [ ] **Step 4: rodar e ver passar** — PASS.

- [ ] **Step 5: commit** — `test:` e `feat:` separados, rodapé `Refs #392`.

---

### Task 3: config `attachments`

**Files:**
- Modify: `src/config.ts` (interface + `validateAttachments` + chamada em `validateConfig`)
- Test: `tests/attachment-config.test.ts`

**Interfaces:**
- Produces: `AttachmentsConfig` (`image.autoResize`, `directory.showHidden`, `artifactTtlDays`, `artifactMaxBytes`), campo `attachments: AttachmentsConfig` em `AstroConfig` com defaults.

- [ ] **Step 1: escrever o teste que falha**

```ts
// tests/attachment-config.test.ts
import { describe, expect, test } from "bun:test";
import { ConfigError, validateConfig } from "../src/config";

const base = {
  providers: { p: { kind: "openai-compat", baseUrl: "http://localhost", credential: "env:KEY" } },
  models: [{ provider: "p", id: "m", tags: ["writing-code"], context: 8192 }],
  agent: { model: "p/m", tools: [] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};
const cfg = (extra: object) => validateConfig({ ...base, ...extra });

describe("config attachments", () => {
  test("defaults", () => {
    expect(cfg({}).attachments).toEqual({ image: { autoResize: false }, directory: { showHidden: false }, artifactTtlDays: 7, artifactMaxBytes: 1024 ** 3 });
  });
  test("sobrescreve", () => {
    const a = cfg({ attachments: { image: { autoResize: true }, directory: { showHidden: true }, artifactTtlDays: 3, artifactMaxBytes: 2048 } }).attachments;
    expect(a).toEqual({ image: { autoResize: true }, directory: { showHidden: true }, artifactTtlDays: 3, artifactMaxBytes: 2048 });
  });
  test("chave desconhecida falha", () => {
    expect(() => cfg({ attachments: { artifactRoot: "/tmp" } })).toThrow(ConfigError);
  });
  test("tipos e positivos", () => {
    expect(() => cfg({ attachments: { artifactTtlDays: 0 } })).toThrow(ConfigError);
    expect(() => cfg({ attachments: { artifactMaxBytes: -1 } })).toThrow(ConfigError);
    expect(() => cfg({ attachments: { image: { autoResize: "yes" } } })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL (`attachments` undefined).

- [ ] **Step 3: implementar**

`AttachmentsConfig` + `validateAttachments(value: unknown): AttachmentsConfig` com vocabulário fechado (`image`, `directory`, `artifactTtlDays`, `artifactMaxBytes`; dentro de `image` só `autoResize`, de `directory` só `showHidden`), `expectBoolean`, `expectPositiveInteger`. `attachments: validateAttachments(root.attachments)` no retorno de `validateConfig` e `attachments: AttachmentsConfig` em `AstroConfig`.

- [ ] **Step 4: rodar e ver passar** — PASS.

- [ ] **Step 5: commit** — `test:`/`feat:`, `Refs #392`.

---

### Task 4: carregamento de path

**Files:**
- Create: `src/attachments/load.ts`
- Test: `tests/attachment-load.test.ts`

**Interfaces:**
- Consumes: `classifyPath` (`src/path-class.ts`), `redactSecrets` (`src/sanitize-external.ts`), `realpathPreservingDots` (`src/tools/paths.ts`), `AttachmentError`/`detectKind`/`parseRange`/`assertAttachmentSize`/`assertImageLimits` (Task 1–2).
- Produces: `LoadAttachmentInput` (`path`, `range?`, `cwd`, `astroHome`, `protectedPaths?`, `showHidden?`, `confirmOutsideCwd?`, `maxBytes?`), `loadAttachment(input): Promise<LoadedAttachment>`, `loadPastedText(text: string): LoadedAttachment`.

- [ ] **Step 1: escrever o teste que falha**

```ts
// tests/attachment-load.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentError, loadAttachment, loadPastedText } from "../src/attachments/load";

const roots: string[] = [];
function sandbox(): { cwd: string; astroHome: string } {
  const root = mkdtempSync(join(tmpdir(), "astro-att-"));
  roots.push(root);
  const cwd = join(root, "work"); const astroHome = join(root, "home");
  mkdirSync(cwd); mkdirSync(astroHome);
  return { cwd, astroHome };
}
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const base = (cwd: string, astroHome: string) => ({ cwd, astroHome });

describe("loadAttachment", () => {
  test("texto: conteúdo, tamanho UTF-8 e redação", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "linha1\nlinha2\nlinha3\n");
    const a = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt" });
    expect(a.kind).toBe("text"); expect(a.mediaType).toBe("text/plain");
    expect(a.data).toContain("linha2"); expect(a.sizeBytes).toBe(Buffer.byteLength(a.data));
  });
  test("range 2:3 devolve só essas linhas", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "a.txt"), "um\ndois\ntres\n");
    const a = await loadAttachment({ ...base(cwd, astroHome), path: "a.txt", range: "2:3" });
    expect(a.data).toBe("dois\ntres"); expect(a.range).toEqual({ start: 2, end: 3 });
  });
  test("hard-block em .env", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, ".env"), "KEY=1");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: ".env" })).rejects.toMatchObject({ code: "attachment_hard_blocked" });
  });
  test("fora do cwd pede confirmação; negado para", async () => {
    const { cwd, astroHome } = sandbox();
    const outside = join(cwd, "..", "outside.txt"); writeFileSync(outside, "x");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "../outside.txt", confirmOutsideCwd: () => false }))
      .rejects.toMatchObject({ code: "attachment_outside_denied" });
    const ok = await loadAttachment({ ...base(cwd, astroHome), path: "../outside.txt", confirmOutsideCwd: () => true });
    expect(ok.kind).toBe("text");
  });
  test("diretório lista e rejeita acima de 500 entradas", async () => {
    const { cwd, astroHome } = sandbox();
    mkdirSync(join(cwd, "dir"));
    for (let i = 0; i < 3; i++) writeFileSync(join(cwd, "dir", `f${i}.txt`), "x");
    const a = await loadAttachment({ ...base(cwd, astroHome), path: "dir" });
    expect(a.kind).toBe("directory"); expect(a.data.split("\n")).toHaveLength(3);
    const big = join(cwd, "big"); mkdirSync(big);
    for (let i = 0; i < 501; i++) writeFileSync(join(big, `f${i}.txt`), "");
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "big" })).rejects.toMatchObject({ code: "attachment_directory_too_large" });
  });
  test("0 byte texto ok; binário rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "empty.txt"), "");
    expect((await loadAttachment({ ...base(cwd, astroHome), path: "empty.txt" })).sizeBytes).toBe(0);
    writeFileSync(join(cwd, "bin"), Buffer.from([0, 1, 2]));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "bin" })).rejects.toMatchObject({ code: "attachment_unsupported_binary" });
  });
  test("imagem 0 byte rejeita", async () => {
    const { cwd, astroHome } = sandbox();
    writeFileSync(join(cwd, "i.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(loadAttachment({ ...base(cwd, astroHome), path: "i.png" })).rejects.toMatchObject({ code: "attachment_image_invalid" });
  });
});

describe("loadPastedText", () => {
  test("texto vira anexo com hash e sem path", () => {
    const a = loadPastedText("colado");
    expect(a.kind).toBe("text"); expect(a.path).toBeUndefined(); expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: rodar e ver falhar** — FAIL (módulo ausente).

- [ ] **Step 3: implementar `load.ts`**

Ordem: expandir `~` → `resolve(cwd, p)` → `realpathPreservingDots` → `classifyPath({ realPath, cwd, astroHome, protectedPaths, artifactRoot: null })`. `hard-block` → `attachment_hard_blocked`. Se `!withinCwd(cwd, real)` (fold win32/darwin) chamar `confirmOutsideCwd`; ausente/false → `attachment_outside_denied`. `statSync`: diretório → `listDirectory` (não recursivo, filtra `.astro`/`.git`/hard-block via classifier, ocultos só com `showHidden`, > 500 → `attachment_directory_too_large`); arquivo → lê até `maxBytes ?? MAX_ATTACHMENT_BYTES + 1` para detectar excesso sem carregar tudo; `detectKind`; texto → `redactSecrets`, aplica range, mede UTF-8; imagem → `assertImageLimits` + base64 + `hash`; binário → `attachment_unsupported_binary`. `loadPastedText`: `redactSecrets`, `hash` SHA-256, `sizeBytes` UTF-8.

- [ ] **Step 4: rodar e ver passar** — PASS.

- [ ] **Step 5: rodar a suíte e o typecheck**

Run: `bun test --max-concurrency=4` e `bun run typecheck`
Expected: tudo verde.

- [ ] **Step 6: commit** — `test:`/`feat:`, `Refs #392`.

---

## Critérios de aceite da fatia

- [ ] `detectKind` por assinatura, SVG como texto, binário/truncado falha fechado.
- [ ] Limites 20/40 MiB, 500 entradas, 25 MPx/8192 px com erro tipado.
- [ ] `range` 1-based, inválido rejeita.
- [ ] Hard-block sem override; fora do cwd exige confirmação; negado para.
- [ ] Texto redigido; 0 byte texto ok, imagem rejeita.
- [ ] `bun test` e `bun run typecheck` verdes.
