/**
 * Provider seed catalog: fills the wizard, it is not a whitelist.
 *
 * Per-provider layout (#553, #601): each folder in `src/providers/<provider>/`
 * has the `adapter.ts` (endpoint/credential/kind) and the `<provider>_models.ts`
 * (offers). Model facts live in `src/models/catalog.ts`; this file only composes.
 */
import type { ProfileModel } from "./profiles";
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
}

function toEntry(seed: ProviderAdapterSeed): CatalogEntry {
  const cards = seed.models.map((offer) => effectiveCard(offer));
  return {
    key: seed.key,
    name: seed.name,
    kind: seed.kind,
    ...(seed.baseUrl === undefined ? {} : { baseUrl: seed.baseUrl }),
    ...(seed.credentialRef === undefined ? {} : { credentialRef: seed.credentialRef }),
    ...(seed.credentialsPath === undefined ? {} : { credentialsPath: seed.credentialsPath }),
    ...(seed.quotaDomain === undefined ? {} : { quotaDomain: seed.quotaDomain }),
    models: profileModelsFor(cards),
    // Each card is already a fresh copy: `effectiveCard` never reuses catalog arrays.
    cards,
  };
}

/** Ordem declarada dos seeds: a mesma que o wizard sempre mostrou. */
const SEEDS: readonly ProviderAdapterSeed[] = [
  nvidiaAdapter,
  codexAdapter,
  openrouterAdapter,
  openaiCompatibleAdapter,
];

export const PROVIDER_CATALOG: readonly CatalogEntry[] = SEEDS.map(toEntry);

export function catalogEntry(key: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}
