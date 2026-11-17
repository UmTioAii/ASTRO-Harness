/**
 * IDs/digests internos do harness (#252): lista única para audit e session
 * store. Quem pode receber output do modelo precisa validar a FORMA do valor;
 * nome de chave sozinho não prova origem nem que o valor é um ID do harness.
 */

/** Chaves de ID/digest internos (audit preserva 64-hex nessas chaves). */
export const INTERNAL_ID_KEY =
  /^(?:ref|sha1|sha256|sha512|hash|digest|checksum|call[-_]?id|handoff[-_]?id|ledger[-_]?id|session[-_]?id|snapshot[-_]?id|trace[-_]?id|span[-_]?id)$/i;

/** Ref do artifact store (ADR-0026): `<session|run>-<sha256>/<sha256>` minúsculo. */
export const ARTIFACT_REF_PATTERN = /^(?:session|run)-[a-f0-9]{64}\/[a-f0-9]{64}$/;

/** SHA-256 em hex minúsculo; forma do `hash` gravado pelo artifact store. */
export const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Metadado de anexo: só neste objeto `hash` é ID interno, não texto do modelo. */
export function isAttachmentMeta(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (meta.kind === "text" || meta.kind === "image" || meta.kind === "directory")
    && typeof meta.name === "string"
    && typeof meta.mediaType === "string";
}
