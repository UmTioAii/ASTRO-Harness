/**
 * Contrato de seed por provider (#553): `<provider>_models.ts` lista os cards,
 * `adapter.ts` descreve endpoint/credencial/kind, `catalog.ts` só compõe.
 */
import type { EffortLevel } from "../call-profile";
import type { ModelStatus, PriceConfig } from "../core/config";
import type { ProfileModel } from "./profiles";

/** Como o provider recebe a chamada. */
export type CallMethod = "chat-completions" | "responses";

/** Ficha curada de um modelo; nunca carrega segredo (I-03). */
export interface ModelCard {
  id: string;
  tags: string[];
  context: number;
  status: ModelStatus;
  /** Modelo expõe raciocínio configurável. */
  reasoning: boolean;
  /** Método de chamada usado pelo adapter. */
  callMethod: CallMethod;
  /** Níveis de effort aceitos; vazio = modelo sem effort. */
  efforts: EffortLevel[];
  /** Preço por 1M de tokens; `null` = sem preço curado (`n/d`, D-10). */
  price: PriceConfig | null;
  /** Modelo declarado gratuito pelo provider. */
  free: boolean;
}

/** Descritor do provider; o adapter de fio continua compartilhado por kind. */
export interface ProviderAdapterSeed {
  key: string;
  name: string;
  kind: "openai-compat" | "codex-oauth";
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  models: readonly ModelCard[];
}

/** Projeta os cards no formato que o perfil/wizard consome. */
export function profileModelsFor(cards: readonly ModelCard[]): ProfileModel[] {
  return cards.map((card) => ({ id: card.id, tags: [...card.tags], context: card.context }));
}
