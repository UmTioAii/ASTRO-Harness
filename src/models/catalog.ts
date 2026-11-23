/**
 * Curated model facts (S3, #601): the single owner of context, output limit,
 * reasoning, efforts, tools, modalities and tags. Offers, price and call method
 * live in `src/providers/<provider>/<provider>_models.ts`; precedence is
 * provider override > catalog fact > code default.
 */
import type { EffortLevel } from "../call-profile";
import type { Tag } from "../tags";

export type ModelModality = "text" | "image" | "audio";

export interface ModelModalities {
  readonly input: readonly ModelModality[];
  readonly output: readonly ModelModality[];
}

/** Facts curated once for a model, shared by every provider that offers it. */
export interface ModelFacts {
  readonly context: number;
  /** Maximum output tokens per response, ≤ `context`. */
  readonly maxOutput: number;
  readonly reasoning: boolean;
  /** Effort levels accepted; empty when `reasoning` is false. */
  readonly efforts: readonly EffortLevel[];
  readonly tools: boolean;
  readonly modalities: ModelModalities;
  /** Closed vocabulary; a typo in a fact or override does not compile (I-21). */
  readonly tags: readonly Tag[];
}

export const MODEL_FACTS = {
  "meta/llama-3.3-70b-instruct": {
    context: 131072, maxOutput: 4096, reasoning: false, efforts: [], tools: true,
    modalities: { input: ["text"], output: ["text"] },
    tags: ["writing-code", "tools", "long-context"],
  },
  "gpt-5.5": {
    context: 400000, maxOutput: 128000, reasoning: true, efforts: ["1", "2", "3"], tools: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    tags: ["writing-code", "tools", "reasoning"],
  },
  "openai/gpt-4o-mini": {
    context: 128000, maxOutput: 16384, reasoning: false, efforts: [], tools: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    tags: ["writing-code", "tools", "fast"],
  },
} as const satisfies Record<string, ModelFacts>;

/** Union of curated ids: an unknown or misspelled id does not compile. */
export type ModelId = keyof typeof MODEL_FACTS;

/** Runtime guard for ids that arrive as strings (config, snapshots, UI). */
export function isModelId(id: string): id is ModelId {
  return Object.prototype.hasOwnProperty.call(MODEL_FACTS, id);
}

export function modelFacts(id: ModelId): ModelFacts {
  return MODEL_FACTS[id];
}
