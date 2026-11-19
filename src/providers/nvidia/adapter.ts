/** Adapter seed da NVIDIA NIM (openai-compat). Modelos: `nvidia_models.ts`. */
import type { ProviderAdapterSeed } from "../seed";
import { NVIDIA_MODELS } from "./nvidia_models";

export const nvidiaAdapter: ProviderAdapterSeed = {
  key: "nvidia",
  name: "NVIDIA",
  kind: "openai-compat",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  credentialRef: "NVIDIA_API_KEY",
  quotaDomain: "nvidia",
  models: NVIDIA_MODELS,
};
