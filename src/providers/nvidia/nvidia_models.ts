/** NVIDIA NIM offers (#601); model facts live in `src/models/catalog.ts`. */
import type { ProviderModel } from "../seed";

export const NVIDIA_MODELS: readonly ProviderModel[] = [
  {
    ref: "meta/llama-3.3-70b-instruct",
    // NIM does not publish a per-token price: uncurated stays `n/d` (D-10).
    price: null,
    free: false,
  },
];
