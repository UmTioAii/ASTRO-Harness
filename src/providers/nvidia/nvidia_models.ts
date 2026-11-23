/** NVIDIA NIM offers (#601); model facts live in `src/models/catalog.ts`. */
import type { ProviderModel } from "../seed";

export const NVIDIA_MODELS: readonly ProviderModel[] = [
  {
    ref: "meta/llama-3.3-70b-instruct",
    price: null,
    free: false,
  },
];
