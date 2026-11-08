/**
 * Projeção de anexos no prompt (ADR-0026, #392): texto e diretório entram no
 * `content` com cabeçalho delimitado; imagem não entra (vai em `images[]`).
 */
import type { AttachmentMeta, LoadedAttachment } from "./model";

/** Cabeçalho do bloco de um anexo de texto/diretório. */
export function attachmentHeader(attachment: LoadedAttachment): string {
  if (attachment.kind === "directory") return `[anexo: ${attachment.name}/]`;
  if (attachment.kind === "image") return `[imagem: ${attachment.name}, ${attachment.sizeBytes} bytes]`;
  const range =
    attachment.range === undefined ? "" : ` (linhas ${attachment.range.start}-${attachment.range.end})`;
  return `[anexo: ${attachment.name}${range}]`;
}

/** Junta prompt + blocos de anexos (texto/diretório); imagem é ignorada. */
export function materializePrompt(prompt: string, attachments: readonly LoadedAttachment[]): string {
  const blocks = attachments
    .filter((attachment) => attachment.kind !== "image")
    .map((attachment) => `${attachmentHeader(attachment)}\n${attachment.data}`);
  if (blocks.length === 0) return prompt;
  return prompt === "" ? blocks.join("\n\n") : `${prompt}\n\n${blocks.join("\n\n")}`;
}

/** Metadado persistível: só os campos do ADR, sem `path` nem payload. */
export function toMeta(attachment: LoadedAttachment): AttachmentMeta {
  const { kind, name, sizeBytes, mediaType, range, ref, hash } = attachment;
  return {
    kind,
    name,
    sizeBytes,
    mediaType,
    ...(range === undefined ? {} : { range }),
    ...(ref === undefined ? {} : { ref }),
    ...(hash === undefined ? {} : { hash }),
  };
}
