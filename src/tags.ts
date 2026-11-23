/**
 * Vocabulário fechado de tags (D-17).
 *
 * Papel/uso descreve para que o modelo é bom; capacidade descreve o que ele
 * suporta. Qualquer tag fora destas listas torna a configuração inválida.
 */

export const ROLE_TAGS = [
  "planning",
  "analysis",
  "writing-text",
  "writing-code",
  "review",
  "testing",
] as const;

export const CAPACITY_TAGS = [
  "tools",
  "reasoning",
  "long-context",
  "vision",
  "fast",
] as const;

/** Every curated tag; facts and overrides are typed with it, so a typo does not compile (I-21). */
export type Tag = (typeof ROLE_TAGS)[number] | (typeof CAPACITY_TAGS)[number];

const KNOWN_TAGS = new Set<string>([...ROLE_TAGS, ...CAPACITY_TAGS]);

export function isKnownTag(tag: string): tag is Tag {
  return KNOWN_TAGS.has(tag);
}
