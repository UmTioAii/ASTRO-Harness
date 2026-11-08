/**
 * Modelo de anexo (ADR-0026, #392): tipos, detecção por magic bytes, limites e
 * dedupe. Puro — sem I/O; `load.ts` e `store.ts` consomem este módulo.
 */

/** Tipo do anexo; `kind` vem de magic bytes, nunca da extensão. */
export type AttachmentKind = "text" | "image" | "directory";

/** Faixa de linhas 1-based inclusiva de um anexo de texto. */
export interface AttachmentRange {
  start: number;
  end: number;
}

/** Descritor de anexo; `sizeBytes` é o payload que entra no prompt. */
export interface Attachment {
  kind: AttachmentKind;
  /** realpath canônico; ausente só para imagem reidratada por `ref`. */
  path?: string;
  name: string;
  sizeBytes: number;
  mediaType: string;
  range?: AttachmentRange;
  /** Ref opaco do artifact store, só imagem persistida. */
  ref?: string;
  /** SHA-256 dos bytes gravados, só imagem com `ref`. */
  hash?: string;
}

/** Metadado persistível: o descritor sem o payload em memória. */
export type AttachmentMeta = Pick<
  Attachment,
  "kind" | "name" | "sizeBytes" | "mediaType" | "range" | "ref" | "hash"
>;

/** Anexo carregado; `data` (texto redigido, base64 ou listagem) nunca é persistido. */
export interface LoadedAttachment extends Attachment {
  data: string;
}

/** Resultado da detecção por magic bytes; `null` = binário fora do whitelist. */
export interface DetectedKind {
  kind: "text" | "image";
  mediaType: string;
}

/** Códigos tipados de anexo (mensagem cita caminho, nunca conteúdo — I-03). */
export type AttachmentErrorCode =
  | "attachment_hard_blocked"
  | "attachment_outside_denied"
  | "attachment_too_large"
  | "attachment_turn_too_large"
  | "attachment_unsupported_binary"
  | "attachment_image_invalid"
  | "attachment_range_invalid"
  | "attachment_directory_too_large"
  | "attachment_root_invalid";

/** Falha de anexo; o `code` é estável para superfícies e testes. */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;
  readonly path?: string;

  constructor(code: AttachmentErrorCode, message: string, path?: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** 20 MiB por anexo (ADR-0026). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 40 MiB somados por turno (ADR-0026). */
export const MAX_TURN_BYTES = 40 * 1024 * 1024;
/** 500 entradas por listagem de diretório (ADR-0026). */
export const MAX_DIRECTORY_ENTRIES = 500;
/** 25 MPx por imagem (ADR-0026). */
export const MAX_IMAGE_PIXELS = 25_000_000;
/** 8192 px no lado maior da imagem (ADR-0026). */
export const MAX_IMAGE_SIDE = 8192;
/** 20 MiB decodificados por imagem (ADR-0026). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

/** Detecta o kind por assinatura; texto exige UTF-8 válido sem NUL. */
export function detectKind(header: Uint8Array): DetectedKind | null {
  if (startsWith(header, PNG_SIGNATURE)) return { kind: "image", mediaType: "image/png" };
  if (startsWith(header, [0xff, 0xd8, 0xff])) return { kind: "image", mediaType: "image/jpeg" };
  if (ascii(header, 0, 6) === "GIF87a" || ascii(header, 0, 6) === "GIF89a") {
    return { kind: "image", mediaType: "image/gif" };
  }
  if (header.length >= 12 && ascii(header, 0, 4) === "RIFF" && ascii(header, 8, 12) === "WEBP") {
    return { kind: "image", mediaType: "image/webp" };
  }
  if (header.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(header);
    return { kind: "text", mediaType: "text/plain" };
  } catch {
    return null;
  }
}

/** Converte `a:b`/`a` em faixa 1-based; fora dos limites lança `attachment_range_invalid`. */
export function parseRange(spec: string, totalLines: number): AttachmentRange {
  const match = /^(\d+)(?::(\d+))?$/.exec(spec.trim());
  if (!match) {
    throw new AttachmentError("attachment_range_invalid", `faixa inválida: "${spec}" (use início:fim, 1-based)`);
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (start < 1 || end < start || end > totalLines) {
    throw new AttachmentError(
      "attachment_range_invalid",
      `faixa fora do arquivo: "${spec}" (o arquivo tem ${totalLines} linha(s))`,
    );
  }
  return { start, end };
}

/** Chave de dedupe: texto/diretório por path+range, imagem/clipboard por hash. */
export function dedupeKey(attachment: Pick<Attachment, "kind" | "path" | "range" | "hash">): string {
  if (attachment.kind === "image") return `image:${attachment.hash ?? ""}`;
  if (attachment.kind === "directory") return `directory:${attachment.path ?? ""}`;
  if (attachment.path === undefined) return `text:clipboard:${attachment.hash ?? ""}`;
  const range = attachment.range === undefined ? "" : `${attachment.range.start}-${attachment.range.end}`;
  return `text:${attachment.path}:${range}`;
}

/** Garante o teto de 20 MiB por anexo. */
export function assertAttachmentSize(sizeBytes: number, name: string): void {
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      "attachment_too_large",
      `anexo "${name}" excede ${MAX_ATTACHMENT_BYTES} bytes (${sizeBytes})`,
    );
  }
}

/** Garante o teto de 40 MiB somados no turno. */
export function assertTurnSize(attachments: readonly Pick<Attachment, "sizeBytes">[]): void {
  const total = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (total > MAX_TURN_BYTES) {
    throw new AttachmentError(
      "attachment_turn_too_large",
      `anexos do turno excedem ${MAX_TURN_BYTES} bytes (${total})`,
    );
  }
}
