/**
 * Curated model facts (S3, #601): the only owner of context, output limit,
 * reasoning, efforts, tools, modalities and tags. Offer, price, status and
 * call method live in `src/providers/<provider>/<provider>_models.ts`.
 *
 * Precedence: provider override > catalog fact > code default. A provider that
 * truncates the context or hides reasoning states it as an override instead of
 * carrying a divergent copy of every other fact.
 */
import type { EffortLevel } from "../call-profile";

/** Input or output a model accepts or produces. */
export type ModelModality = "text" | "image" | "audio";

export interface ModelModalities {
  readonly input: readonly ModelModality[];
  readonly output: readonly ModelModality[];
}

/** Facts curated once for a model, shared by every provider that offers it. */
export interface ModelFacts {
  /** Context window in tokens, > 0. */
  readonly context: number;
  /** Maximum output tokens per response, ≤ `context`. */
  readonly maxOutput: number;
  /** Model exposes configurable reasoning. */
  readonly reasoning: boolean;
  /** Effort levels accepted; empty when `reasoning` is false. */
  readonly efforts: readonly EffortLevel[];
  /** Tool calling supported. */
  readonly tools: boolean;
  readonly modalities: ModelModalities;
  /** Curated tags from the closed vocabulary in `src/tags.ts` (I-21). */
  readonly tags: readonly string[];
}

export const MODEL_FACTS = {
  "meta/llama-3.3-70b-instruct": {
    context: 131072,
    maxOutput: 4096,
    // Llama 3.3 is instruct, not reasoning: no configurable effort.
    reasoning: false,
    efforts: [],
    tools: true,
    modalities: { input: ["text"], output: ["text"] },
    tags: ["writing-code", "tools", "long-context"],
  },
  "gpt-5.5": {
    context: 400000,
    maxOutput: 128000,
    reasoning: true,
    // CLI scale: low/medium/high map to 1/2/3.
    efforts: ["1", "2", "3"],
    tools: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    tags: ["writing-code", "tools", "reasoning"],
  },
  "openai/gpt-4o-mini": {
    context: 128000,
    maxOutput: 16384,
    reasoning: false,
    efforts: [],
    tools: true,
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

/** Curated facts for a model; providers resolve their offers through this. */
export function modelFacts(id: ModelId): ModelFacts {
  return MODEL_FACTS[id];
}
