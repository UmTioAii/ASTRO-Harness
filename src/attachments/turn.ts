/**
 * Preparo do turno de anexos (ADR-0026, #392): dedupe, teto de 40 MiB,
 * aprovação explícita de imagem, persistência no artifact store e auditoria.
 * Conteúdo (base64) nunca sai daqui para audit/log — só ref, hash, bytes e tipo.
 */
import type { ImagePart } from "../provider/types";
import {
  assertTurnSize,
  dedupeKey,
  imageDimensions,
  AttachmentError,
  type AttachmentMeta,
  type LoadedAttachment,
} from "./model";
import { toMeta } from "./render";
import type { ArtifactOwner, ArtifactStore, StoredArtifact } from "./store";

/** Item mostrado ao aprovador; nunca carrega o conteúdo da imagem. */
export interface AttachmentApprovalItem {
  name: string;
  path?: string;
  mediaType: string;
  sizeBytes: number;
  pixels?: { width: number; height: number };
}

/** Aprovação explícita do lote de imagens; ausente nega (fail closed). */
export type AttachmentApprover = (items: readonly AttachmentApprovalItem[]) => Promise<boolean> | boolean;

export interface PrepareTurnInput {
  attachments: readonly LoadedAttachment[];
  owner: ArtifactOwner;
  approver?: AttachmentApprover;
  store?: ArtifactStore;
  audit?: (tipo: string, payload: Record<string, unknown>) => void;
}

export interface PreparedTurn {
  attachments: LoadedAttachment[];
  images: ImagePart[];
  metas: AttachmentMeta[];
}

/** Texto do prompt de aprovação: uma linha por imagem, sem conteúdo. */
export function formatApprovalPrompt(items: readonly AttachmentApprovalItem[]): string {
  const lines = ["imagens deste turno (não redigíveis):"];
  items.forEach((item, index) => {
    const size = item.pixels === undefined
      ? "dimensão desconhecida"
      : `${item.pixels.width}x${item.pixels.height} (${((item.pixels.width * item.pixels.height) / 1_000_000).toFixed(1)} MPx)`;
    lines.push(`${index + 1}. ${item.name} - ${item.sizeBytes} bytes - ${size}`);
  });
  return lines.join("\n");
}

function approvalItem(attachment: LoadedAttachment): AttachmentApprovalItem {
  const pixels = imageDimensions(Buffer.from(attachment.data, "base64"), attachment.mediaType);
  return {
    name: attachment.name,
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    ...(pixels === null ? {} : { pixels }),
  };
}

/**
 * Prepara os anexos de um turno: deduplica preservando a primeira ocorrência,
 * aplica o teto de 40 MiB, exige aprovação para imagem, grava cada imagem no
 * artifact store e devolve cópias com `ref`/`hash` mais as `images` do provider.
 */
export async function prepareTurnAttachments(input: PrepareTurnInput): Promise<PreparedTurn> {
  const seen = new Set<string>();
  const unique: LoadedAttachment[] = [];
  for (const attachment of input.attachments) {
    const key = dedupeKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(attachment);
  }
  assertTurnSize(unique);

  const images = unique.filter((attachment) => attachment.kind === "image");
  const stored = new Map<LoadedAttachment, StoredArtifact>();
  if (images.length > 0) {
    if (input.approver === undefined) {
      throw new AttachmentError(
        "attachment_image_denied",
        "imagem anexada exige aprovação explícita; sem aprovador o turno é negado",
      );
    }
    const approved = await input.approver(images.map(approvalItem));
    if (!approved) {
      throw new AttachmentError("attachment_image_denied", "envio de imagem não aprovado pelo usuário");
    }
    const store = input.store;
    if (store === undefined) {
      throw new AttachmentError("attachment_root_invalid", "artifact store indisponível para persistir a imagem");
    }
    for (const attachment of images) {
      stored.set(attachment, store.save(input.owner, Buffer.from(attachment.data, "base64"), attachment.mediaType));
    }
  }

  const attachments = unique.map((attachment) => {
    const saved = stored.get(attachment);
    return saved === undefined ? attachment : { ...attachment, ref: saved.ref, hash: saved.hash };
  });
  const parts: ImagePart[] = images.map((attachment) => ({
    mediaType: attachment.mediaType,
    dataBase64: attachment.data,
  }));
  if (stored.size > 0) {
    input.audit?.("attachment.approved", {
      images: [...stored].map(([attachment, saved]) => ({
        ref: saved.ref,
        hash: saved.hash,
        bytes: saved.bytes,
        mediaType: attachment.mediaType,
      })),
    });
  }

  return { attachments, images: parts, metas: attachments.map(toMeta) };
}
