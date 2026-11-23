/** Codex offers (#601); model facts live in `src/models/catalog.ts`. */
import type { ProviderModel } from "../seed";

export const CODEX_MODELS: readonly ProviderModel[] = [
  {
    ref: "gpt-5.5",
    // Codex uses the Responses endpoint; the catalog fact stays transport-free.
    callMethod: "responses",
    price: null,
    free: false,
  },
];
