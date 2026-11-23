/**
 * Per-provider seed contract (S3, #601): `<provider>_models.ts` lists offers
 * (ref, price, status, call method, explicit overrides), `adapter.ts` describes
 * transport, credentials and quota, and `catalog.ts` only composes. Model facts
 * live in `src/models/catalog.ts`.
 */
import type { ModelStatus, PriceConfig } from "../core/config";
import type { ModelFacts, ModelId } from "../models/catalog";
import { modelFacts } from "../models/catalog";
import type { ProfileModel } from "./profiles";

/** How the provider receives the call. */
export type CallMethod = "chat-completions" | "responses";

/**
 * What a provider offers: a catalog ref plus the facts that belong to the
 * offer itself. Never carries a secret (I-03).
 */
export interface ProviderModel {
  /** Curated catalog id; an unknown or misspelled id does not compile. */
  ref: ModelId;
  /** Price per 1M tokens; `null` = no curated price (`n/d`, D-10). */
  price: PriceConfig | null;
  /** Provider declares the model free. */
  free: boolean;
  /** State in this provider's offer; default `active`. */
  status?: ModelStatus;
  /** Endpoint used by the adapter; default `chat-completions`. */
  callMethod?: CallMethod;
  /** Facts this gateway changes; precedence override > catalog fact. */
  overrides?: Partial<ModelFacts>;
}

/** Effective card after offer overrides are applied over the catalog facts. */
export interface ModelCard extends ModelFacts {
  readonly id: ModelId;
  readonly status: ModelStatus;
  readonly callMethod: CallMethod;
  readonly price: PriceConfig | null;
  readonly free: boolean;
}

/** Descriptor of the provider; the wire adapter is still shared by kind. */
export interface ProviderAdapterSeed {
  key: string;
  name: string;
  kind: "openai-compat" | "codex-oauth";
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  models: readonly ProviderModel[];
}

const DEFAULT_CALL_METHOD: CallMethod = "chat-completions";

/** Resolves an offer into the complete card the catalog and UI consume. */
export function effectiveCard(offer: ProviderModel): ModelCard {
  const overrides = offer.overrides ?? {};
  const merged: ModelFacts = { ...modelFacts(offer.ref), ...overrides };
  return {
    id: offer.ref,
    context: merged.context,
    maxOutput: merged.maxOutput,
    reasoning: merged.reasoning,
    efforts: [...merged.efforts],
    tools: merged.tools,
    modalities: { input: [...merged.modalities.input], output: [...merged.modalities.output] },
    tags: [...merged.tags],
    status: offer.status ?? "active",
    callMethod: offer.callMethod ?? DEFAULT_CALL_METHOD,
    price: offer.price,
    free: offer.free,
  };
}

/** Projects the cards into the shape consumed by profiles and the wizard. */
export function profileModelsFor(cards: readonly ModelCard[]): ProfileModel[] {
  return cards.map((card) => ({ id: card.id, tags: [...card.tags], context: card.context }));
}
