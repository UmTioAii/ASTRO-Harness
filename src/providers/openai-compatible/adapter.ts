/** Adapter seed do template openai-compat. Modelos: `openai_compatible_models.ts`. */
import type { ProviderAdapterSeed } from "../seed";
import { OPENAI_COMPATIBLE_MODELS } from "./openai_compatible_models";

export const openaiCompatibleAdapter: ProviderAdapterSeed = {
  key: "openai-compatible",
  name: "OpenAI Compatible",
  kind: "openai-compat",
  quotaDomain: "openai-compatible",
  models: OPENAI_COMPATIBLE_MODELS,
};
