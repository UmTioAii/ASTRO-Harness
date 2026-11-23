/**
 * Provider seed catalog: fills the wizard, it is not a whitelist.
 *
 * Per-provider layout (#553, #601): each folder in `src/providers/<provider>/`
 * has the `adapter.ts` (endpoint/credential/kind) and the `<provider>_models.ts`
 * (offers). Model facts live in `src/models/catalog.ts`; this file only composes.
 */
import type { ProfileModel } from "./profiles";
import { ModelOverrideError } from "../models/overrides";
import { effectiveCard, profileModelsFor, type ModelCard, type ProviderAdapterSeed } from "./seed";
import { nvidiaAdapter } from "./nvidia/adapter";
import { codexAdapter } from "./codex/adapter";
import { openrouterAdapter } from "./openrouter/adapter";
import { openaiCompatibleAdapter } from "./openai-compatible/adapter";

export interface CatalogEntry {
  key: string;
  name: string;
  kind: "openai-compat" | "codex-oauth";
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  /** Domínio de quota do seed; o wizard grava no perfil. */
  quotaDomain?: string;
  models: ProfileModel[];
  /** Cards completos (reasoning/effort/preço/free) para a UI de provider. */
  cards: readonly ModelCard[];
  /** Malformed overrides found while composing (#625); the offer contributes no card. */
  overrideErrors?: readonly ModelOverrideError[];
}

/**
 * Composes one seed into a catalog entry. A malformed override fails closed for
 * that offer (no card) and is recorded for `astro doctor` instead of crashing
 * startup; any other error still propagates.
 */
export function composeEntry(seed: ProviderAdapterSeed): CatalogEntry {
  const cards: ModelCard[] = [];
  const overrideErrors: ModelOverrideError[] = [];
  for (const offer of seed.models) {
    try {
      cards.push(effectiveCard(offer));
    } catch (error) {
      if (!(error instanceof ModelOverrideError)) throw error;
      overrideErrors.push(error);
    }
  }
  return {
    key: seed.key,
    name: seed.name,
    kind: seed.kind,
    ...(seed.baseUrl === undefined ? {} : { baseUrl: seed.baseUrl }),
    ...(seed.credentialRef === undefined ? {} : { credentialRef: seed.credentialRef }),
    ...(seed.credentialsPath === undefined ? {} : { credentialsPath: seed.credentialsPath }),
    ...(seed.quotaDomain === undefined ? {} : { quotaDomain: seed.quotaDomain }),
    models: profileModelsFor(cards),
    cards,
    ...(overrideErrors.length === 0 ? {} : { overrideErrors }),
  };
}

/** Ordem declarada dos seeds: a mesma que o wizard sempre mostrou. */
const SEEDS: readonly ProviderAdapterSeed[] = [
  nvidiaAdapter,
  codexAdapter,
  openrouterAdapter,
  openaiCompatibleAdapter,
];

export const PROVIDER_CATALOG: readonly CatalogEntry[] = SEEDS.map(composeEntry);

export function catalogEntry(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}
