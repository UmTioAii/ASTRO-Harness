/**
 * Catálogo seed de providers: preenche o wizard, não é whitelist.
 *
 * Layout por provider (#553): cada pasta em `src/providers/<provider>/` tem o
 * `adapter.ts` (endpoint/credencial/kind) e o `<provider>_models.ts` (model
 * cards). Este arquivo só compõe os seeds — nenhum dado de modelo mora aqui.
 */
import type { ProfileModel } from "./profiles";
import type { ModelCard, ProviderAdapterSeed } from "./seed";
import { profileModelsFor } from "./seed";
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
  return {
    key: seed.key,
    name: seed.name,
    kind: seed.kind,
    ...(seed.baseUrl === undefined ? {} : { baseUrl: seed.baseUrl }),
    ...(seed.credentialRef === undefined ? {} : { credentialRef: seed.credentialRef }),
    ...(seed.credentialsPath === undefined ? {} : { credentialsPath: seed.credentialsPath }),
    ...(seed.quotaDomain === undefined ? {} : { quotaDomain: seed.quotaDomain }),
    models: profileModelsFor(seed.models),
    // Cópia: a UI pode ordenar/editar sem alterar o módulo de seed.
    cards: seed.models.map((card) => ({ ...card, tags: [...card.tags] })),
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
