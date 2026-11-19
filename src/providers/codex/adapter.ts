/** Adapter seed do Codex (codex-oauth). Modelos: `codex_models.ts`. */
import type { ProviderAdapterSeed } from "../seed";
import { CODEX_MODELS } from "./codex_models";

export const codexAdapter: ProviderAdapterSeed = {
  key: "codex",
  name: "Codex",
  kind: "codex-oauth",
  credentialsPath: "~/.codex/auth.json",
  quotaDomain: "codex",
  models: CODEX_MODELS,
};
