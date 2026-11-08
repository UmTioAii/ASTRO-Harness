/**
 * Carregamento de anexo a partir de path ou clipboard (ADR-0026, #392).
 * Faz I/O: canonicaliza, classifica (ADR-0027) e aplica hard-block sem override,
 * confirmação fora do cwd e limites. Consome `model.ts` (puro).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { classifyPath, createPathClassifier, type PathClassifierContext } from "../path-class";
import { redactSecrets } from "../sanitize-external";
import { canonicalize, realpathPreservingDots } from "../tools/paths";
import {
  assertAttachmentSize,
  assertImageLimits,
  detectKind,
  MAX_ATTACHMENT_BYTES,
  MAX_DIRECTORY_ENTRIES,
  parseRange,
  AttachmentError,
  type LoadedAttachment,
} from "./model";

export { AttachmentError };

/** Entrada de `loadAttachment`; `confirmOutsideCwd` é injetado pela superfície. */
export interface LoadAttachmentInput {
  path: string;
  /** Faixa 1-based opcional, só para texto (`início:fim` ou `linha`). */
  range?: string;
  cwd: string;
  astroHome: string;
  protectedPaths?: readonly string[];
  /** `attachments.directory.showHidden`. */
  showHidden?: boolean;
  /** Fora do cwd pede confirmação; ausente ou `false` falha fechado (I-19). */
  confirmOutsideCwd?: (absolutePath: string) => Promise<boolean> | boolean;
  /** Teto de leitura em bytes; default 20 MiB. */
  maxBytes?: number;
}

/** Case-fold em win32/darwin (ADR-0026); demais plataformas preservam case. */
function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

/** `real` dentro de `cwd` (comparação por realpath, case-fold nas plataformas do ADR). */
function withinCwd(cwd: string, real: string): boolean {
  const rel = relative(fold(canonicalize(cwd)), fold(real));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/** Expande `~` e `~usuario` (só o usuário atual); `~outro` falha fechado (null). */
function expandHome(input: string): string | null {
  const match = /^~([^\\/]*)([\\/][\s\S]*)?$/.exec(input);
  if (!match) return input;
  if (match[1] === "") return match[2] ? join(homedir(), match[2].slice(1)) : homedir();
  const info = userInfo();
  return match[1] === info.username ? join(info.homedir, match[2]?.slice(1) ?? "") : null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Listagem não recursiva de diretório, com filtros e teto de 500 entradas. */
function listDirectory(
  real: string,
  context: Pick<PathClassifierContext, "cwd" | "astroHome" | "protectedPaths"> & { showHidden: boolean },
): string {
  const classify = createPathClassifier({
    cwd: context.cwd,
    astroHome: context.astroHome,
    protectedPaths: context.protectedPaths,
    artifactRoot: null,
  });
  const lines: string[] = [];
  for (const entry of readdirSync(real, { withFileTypes: true })) {
    if (entry.name === ".astro" || entry.name === ".git") continue;
    if (!context.showHidden && entry.name.startsWith(".")) continue;
    const childReal = realpathPreservingDots(join(real, entry.name), context.cwd);
    if (classify(childReal) === "hard-block") continue;
    let size = "<dir>";
    try {
      const stats = statSync(childReal);
      size = stats.isDirectory() ? "<dir>" : String(stats.size);
    } catch {
      continue;
    }
    lines.push(`${entry.name}\t${size}`);
  }
  if (lines.length > MAX_DIRECTORY_ENTRIES) {
    throw new AttachmentError(
      "attachment_directory_too_large",
      `diretório "${basename(real)}" tem ${lines.length} entradas após filtros (máx ${MAX_DIRECTORY_ENTRIES}); use um filtro`,
      real,
    );
  }
  lines.sort();
  return lines.join("\n");
}

/**
 * Carrega um anexo de `path`. Ordem: expande `~` → realpath → classify com
 * `artifactRoot: null` (a raiz de artefato é destino, nunca fonte) → hard-block
 * sem override → fora do cwd pede `confirmOutsideCwd` → leitura e limites.
 */
export async function loadAttachment(input: LoadAttachmentInput): Promise<LoadedAttachment> {
  const expanded = expandHome(input.path);
  if (expanded === null) {
    throw new AttachmentError("attachment_hard_blocked", `path não resolvível: ${input.path}`);
  }
  const absolute = isAbsolute(expanded) ? expanded : resolve(input.cwd, expanded);
  const real = realpathPreservingDots(absolute, input.cwd);

  const pathClass = classifyPath({
    realPath: real,
    cwd: input.cwd,
    astroHome: input.astroHome,
    protectedPaths: input.protectedPaths,
    artifactRoot: null,
  });
  if (pathClass === "hard-block") {
    throw new AttachmentError("attachment_hard_blocked", `caminho bloqueado: ${real}`, real);
  }

  if (!withinCwd(input.cwd, real)) {
    const approved = input.confirmOutsideCwd === undefined ? false : await input.confirmOutsideCwd(real);
    if (!approved) {
      throw new AttachmentError(
        "attachment_outside_denied",
        `anexo fora do diretório de trabalho não aprovado: ${real}`,
        real,
      );
    }
  }

  const stats = statSync(real);
  const name = basename(real);

  if (stats.isDirectory()) {
    if (input.range !== undefined) {
      throw new AttachmentError("attachment_range_invalid", "range só vale para anexo de texto", real);
    }
    const listing = listDirectory(real, {
      cwd: input.cwd,
      astroHome: input.astroHome,
      protectedPaths: input.protectedPaths,
      showHidden: input.showHidden === true,
    });
    const sizeBytes = Buffer.byteLength(listing, "utf8");
    assertAttachmentSize(sizeBytes, name);
    return { kind: "directory", path: real, name, sizeBytes, mediaType: "inode/directory", data: listing };
  }

  const limit = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (stats.size > limit) {
    throw new AttachmentError(
      "attachment_too_large",
      `anexo "${name}" excede ${limit} bytes (${stats.size})`,
      real,
    );
  }
  const bytes = new Uint8Array(readFileSync(real));
  const detected = detectKind(bytes);
  if (detected === null) {
    throw new AttachmentError("attachment_unsupported_binary", `tipo não suportado: ${name}`, real);
  }

  if (detected.kind === "image") {
    if (input.range !== undefined) {
      throw new AttachmentError("attachment_range_invalid", "range não vale para imagem", real);
    }
    assertImageLimits(bytes, detected.mediaType, bytes.length);
    assertAttachmentSize(bytes.length, name);
    return {
      kind: "image",
      path: real,
      name,
      sizeBytes: bytes.length,
      mediaType: detected.mediaType,
      data: Buffer.from(bytes).toString("base64"),
      hash: sha256(bytes),
    };
  }

  let text = redactSecrets(Buffer.from(bytes).toString("utf8"));
  let range: LoadedAttachment["range"];
  if (input.range !== undefined) {
    range = parseRange(input.range, text.split("\n").length);
    text = text
      .split("\n")
      .slice(range.start - 1, range.end)
      .join("\n");
  }
  const sizeBytes = Buffer.byteLength(text, "utf8");
  assertAttachmentSize(sizeBytes, name);
  return {
    kind: "text",
    path: real,
    name,
    sizeBytes,
    mediaType: detected.mediaType,
    ...(range === undefined ? {} : { range }),
    data: text,
  };
}

/** Texto do clipboard: sem path, dedupe por SHA-256 do conteúdo redigido. */
export function loadPastedText(text: string): LoadedAttachment {
  const redacted = redactSecrets(text);
  return {
    kind: "text",
    name: "clipboard",
    sizeBytes: Buffer.byteLength(redacted, "utf8"),
    mediaType: "text/plain",
    data: redacted,
    hash: createHash("sha256").update(redacted, "utf8").digest("hex"),
  };
}
