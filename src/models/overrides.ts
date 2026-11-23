/**
 * Provider overrides over curated facts (S3, #625): validates the resolved facts
 * at resolution time and describes what each override changed, so `astro doctor`
 * and `/usage` show the effective value next to the catalog value before a call
 * fails. Pure, no I/O and no network; never carries a credential (I-03).
 */
import type { ModelFacts, ModelId } from "./catalog";
import { modelFacts } from "./catalog";

/** Card facts with the curated id; the shape `ModelCard` satisfies. */
export interface CardFacts extends ModelFacts {
  readonly id: ModelId;
}

/** One overridden fact: the effective value and the catalog value it replaced. */
export interface OverrideNote {
  field: string;
  effective: string;
  catalog: string;
}

/** Fields an override can make malformed; named in the error for the failed resolution. */
export type OverrideField = "context" | "maxOutput" | "efforts";

/** Classified rejection of facts an override made impossible (fail closed at resolution). */
export class ModelOverrideError extends Error {
  readonly code = "config_invalid_model_facts";

  constructor(
    readonly ref: ModelId,
    readonly field: OverrideField,
    readonly reason: string,
  ) {
    super(`provider override invalid: "${ref}.${field}" ${reason}`);
    this.name = "ModelOverrideError";
  }
}

function positive(ref: ModelId, field: OverrideField, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelOverrideError(ref, field, `must be a positive integer (got ${value})`);
  }
}

/**
 * Validates the merged facts (catalog + override) before they reach a card.
 * A narrowed context may clamp an inherited output cap (documented gateway
 * case); a cap the override declares above the context is a malformed offer.
 */
export function validateFacts(
  ref: ModelId,
  facts: ModelFacts,
  overrides: Partial<ModelFacts>,
): void {
  positive(ref, "context", facts.context);
  positive(ref, "maxOutput", facts.maxOutput);
  if (overrides.maxOutput !== undefined && overrides.maxOutput > facts.context) {
    throw new ModelOverrideError(ref, "maxOutput", `cannot exceed context ${facts.context}`);
  }
  if (facts.reasoning && facts.efforts.length === 0) {
    throw new ModelOverrideError(ref, "efforts", "reasoning requires at least one effort level");
  }
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "-" : values.join(",");
}

function modalities(value: ModelFacts["modalities"]): string {
  return `${list(value.input)}>${list(value.output)}`;
}

/** Every fact the provider card changed, with both values; empty without an override. */
export function overrideNotes(card: CardFacts): OverrideNote[] {
  const base = modelFacts(card.id);
  const notes: OverrideNote[] = [];
  const add = (field: string, effective: string, catalog: string): void => {
    if (effective !== catalog) notes.push({ field, effective, catalog });
  };
  add("context", String(card.context), String(base.context));
  add("maxOutput", String(card.maxOutput), String(base.maxOutput));
  add("reasoning", String(card.reasoning), String(base.reasoning));
  add("efforts", list(card.efforts), list(base.efforts));
  add("tools", String(card.tools), String(base.tools));
  add("modalities", modalities(card.modalities), modalities(base.modalities));
  add("tags", list(card.tags), list(base.tags));
  return notes;
}

/** One `field effective (catalog value)` segment per overridden fact. */
export function formatOverrideNotes(notes: readonly OverrideNote[]): string {
  return notes.map((note) => `${note.field} ${note.effective} (catalog ${note.catalog})`).join(" · ");
}

/**
 * Effective card for a `provider/id` ref. The provider never contains `/`, the
 * model id may (`meta/llama-3.3-70b-instruct`), so only the first segment splits.
 */
export function cardFor(
  ref: string,
  entries: readonly { readonly key: string; readonly cards: readonly CardFacts[] }[],
): CardFacts | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  return entries.find((entry) => entry.key === provider)?.cards.find((card) => card.id === id);
}
