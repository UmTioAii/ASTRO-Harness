/** OpenRouter offers (#601); model facts live in `src/models/catalog.ts`. */
import type { ProviderModel } from "../seed";

export const OPENROUTER_MODELS: readonly ProviderModel[] = [
  {
    ref: "openai/gpt-4o-mini",
    price: {
      inputPerM: 0.15,
      outputPerM: 0.6,
      fonte: "https://openrouter.ai/openai/gpt-4o-mini",
      verificado: false,
    },
    free: false,
  },
];
