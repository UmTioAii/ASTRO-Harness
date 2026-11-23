import { describe, expect, test } from "bun:test";
import { modelFacts } from "../src/models/catalog";
import { PROVIDER_CATALOG, catalogEntry } from "../src/providers/catalog";
import { nvidiaAdapter } from "../src/providers/nvidia/adapter";
import { NVIDIA_MODELS } from "../src/providers/nvidia/nvidia_models";
import { codexAdapter } from "../src/providers/codex/adapter";
import { CODEX_MODELS } from "../src/providers/codex/codex_models";
import { openrouterAdapter } from "../src/providers/openrouter/adapter";
import { OPENROUTER_MODELS } from "../src/providers/openrouter/openrouter_models";
import { openaiCompatibleAdapter } from "../src/providers/openai-compatible/adapter";
import { OPENAI_COMPATIBLE_MODELS } from "../src/providers/openai-compatible/openai_compatible_models";
import type { ModelCard } from "../src/providers/seed";
import { effectiveCard } from "../src/providers/seed";

const SEEDS = [
  { adapter: nvidiaAdapter, models: NVIDIA_MODELS },
  { adapter: codexAdapter, models: CODEX_MODELS },
  { adapter: openrouterAdapter, models: OPENROUTER_MODELS },
  { adapter: openaiCompatibleAdapter, models: OPENAI_COMPATIBLE_MODELS },
];

/** Saída do catálogo antes da mudança de layout (#553): paridade obrigatória. */
const PARITY = JSON.parse(`[
  {"key":"nvidia","name":"NVIDIA","kind":"openai-compat","baseUrl":"https://integrate.api.nvidia.com/v1","credentialRef":"NVIDIA_API_KEY","quotaDomain":"nvidia","models":[{"id":"meta/llama-3.3-70b-instruct","tags":["writing-code","tools","long-context"],"context":131072}]},
  {"key":"codex","name":"Codex","kind":"codex-oauth","credentialsPath":"~/.codex/auth.json","quotaDomain":"codex","models":[{"id":"gpt-5.5","tags":["writing-code","tools","reasoning"],"context":400000}]},
  {"key":"openrouter","name":"OpenRouter","kind":"openai-compat","baseUrl":"https://openrouter.ai/api/v1","credentialRef":"OPENROUTER_API_KEY","quotaDomain":"openrouter","models":[{"id":"openai/gpt-4o-mini","tags":["writing-code","tools","fast"],"context":128000}]},
  {"key":"openai-compatible","name":"OpenAI Compatible","kind":"openai-compat","quotaDomain":"openai-compatible","models":[]}
]`);

describe("per-provider layout (#553)", () => {
  test("catalog output is exactly the pre-refactor output", () => {
    const derived = PROVIDER_CATALOG.map((entry) => ({
      key: entry.key,
      name: entry.name,
      kind: entry.kind,
      ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }),
      ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
      ...(entry.credentialsPath === undefined ? {} : { credentialsPath: entry.credentialsPath }),
      ...(entry.quotaDomain === undefined ? {} : { quotaDomain: entry.quotaDomain }),
      models: entry.models,
    }));
    expect(derived).toEqual(PARITY);
  });

  test("each catalog entry derives from its provider adapter and models file", () => {
    for (const { adapter, models } of SEEDS) {
      const entry = catalogEntry(adapter.key);
      expect(entry).toBeDefined();
      expect(entry!.models.map((model) => model.id)).toEqual(models.map((offer) => offer.ref));
    }
  });

  test("every model card declares the full contract", () => {
    const cards: ModelCard[] = SEEDS.flatMap((seed) => seed.models.map((offer) => effectiveCard(offer)));
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(typeof card.id).toBe("string");
      expect(card.id.length).toBeGreaterThan(0);
      expect(Array.isArray(card.tags)).toBe(true);
      expect(card.context).toBeGreaterThan(0);
      expect(card.maxOutput).toBeLessThanOrEqual(card.context);
      expect(["active", "deprecated", "disabled"]).toContain(card.status);
      expect(typeof card.reasoning).toBe("boolean");
      expect(["chat-completions", "responses"]).toContain(card.callMethod);
      expect(Array.isArray(card.efforts)).toBe(true);
      if (card.price !== null) {
        expect(card.price.inputPerM).toBeGreaterThanOrEqual(0);
        expect(card.price.outputPerM).toBeGreaterThanOrEqual(0);
        expect(card.price.fonte).toMatch(/^https?:\/\//);
        expect(typeof card.price.verificado).toBe("boolean");
      }
      expect(typeof card.free).toBe("boolean");
      if (card.reasoning) expect(card.efforts.length).toBeGreaterThan(0);
      else expect(card.efforts).toHaveLength(0);
      if (card.free) expect(card.price === null || (card.price.inputPerM === 0 && card.price.outputPerM === 0)).toBe(true);
    }
    expect(cards.some((card) => card.reasoning)).toBe(true);
  });

  test("seeds only name credentials, never carry a value (I-03)", () => {
    for (const { adapter, models } of SEEDS) {
      if (adapter.credentialRef !== undefined) expect(adapter.credentialRef).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      expect(JSON.stringify(adapter) + JSON.stringify(models)).not.toMatch(/sk-|api[_-]?key\s*[:=]/i);
    }
  });

  test("cards exposed by the catalog do not share state with the catalog facts", () => {
    const entry = catalogEntry("nvidia")!;
    (entry.cards[0]!.tags as string[]).push("leak");
    expect(modelFacts("meta/llama-3.3-70b-instruct").tags).not.toContain("leak");
  });

  test("cards reach the catalog entry for the provider UI", () => {
    const entry = catalogEntry("nvidia");
    expect(entry!.cards.map((card) => card.id)).toEqual(NVIDIA_MODELS.map((offer) => offer.ref));
  });
});
