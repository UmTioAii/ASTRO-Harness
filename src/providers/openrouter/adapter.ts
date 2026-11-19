/** Adapter seed do OpenRouter (openai-compat). Modelos: `openrouter_models.ts`. */
import type { ProviderAdapterSeed } from "../seed";
import { OPENROUTER_MODELS } from "./openrouter_models";

export const openrouterAdapter: ProviderAdapterSeed = {
  key: "openrouter",
  name: "OpenRouter",
  kind: "openai-compat",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialRef: "OPENROUTER_API_KEY",
  quotaDomain: "openrouter",
  models: OPENROUTER_MODELS,
};
