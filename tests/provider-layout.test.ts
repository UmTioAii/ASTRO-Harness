import { describe, expect, test } from "bun:test";
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

const SEEDS = [
  { adapter: nvidiaAdapter, models: NVIDIA_MODELS },
  { adapter: codexAdapter, models: CODEX_MODELS },
  { adapter: openrouterAdapter, models: OPENROUTER_MODELS },
  { adapter: openaiCompatibleAdapter, models: OPENAI_COMPATIBLE_MODELS },
];

/** Saída do catálogo antes da mudança de layout (#553): paridade obrigatória. */
interface ParityRow {
  key: string;
  name: string;
  kind: "openai-compat" | "codex-oauth";
  baseUrl?: string;
  credentialRef?: string;
  credentialsPath?: string;
  quotaDomain?: string;
  models: Array<{ id: string; tags: string[]; context: number }>;
}

const PARITY: ParityRow[] = [
  {
    key: "nvidia",
    name: "NVIDIA",
    kind: "openai-compat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialRef: "NVIDIA_API_KEY",
    quotaDomain: "nvidia",
    models: [{ id: "meta/llama-3.3-70b-instruct", tags: ["writing-code", "tools", "long-context"], context: 131072 }],
  },
  {
    key: "codex",
    name: "Codex",
    kind: "codex-oauth",
    credentialsPath: "~/.codex/auth.json",
    quotaDomain: "codex",
    models: [{ id: "gpt-5.5", tags: ["writing-code", "tools", "reasoning"], context: 400000 }],
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialRef: "OPENROUTER_API_KEY",
    quotaDomain: "openrouter",
    models: [{ id: "openai/gpt-4o-mini", tags: ["writing-code", "tools", "fast"], context: 128000 }],
  },
  {
    key: "openai-compatible",
    name: "OpenAI Compatible",
    kind: "openai-compat",
    quotaDomain: "openai-compatible",
    models: [],
  },
];

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
      expect(entry!.name).toBe(adapter.name);
      expect(entry!.kind).toBe(adapter.kind);
      expect(entry!.baseUrl).toBe(adapter.baseUrl);
      expect(entry!.credentialRef).toBe(adapter.credentialRef);
      expect(entry!.credentialsPath).toBe(adapter.credentialsPath);
      expect(entry!.quotaDomain).toBe(adapter.quotaDomain);
      expect(entry!.models.map((model) => model.id)).toEqual(models.map((card) => card.id));
      expect(entry!.models.map((model) => model.context)).toEqual(models.map((card) => card.context));
      expect(entry!.models.map((model) => model.tags)).toEqual(models.map((card) => card.tags));
    }
  });

  test("every model card declares the full contract", () => {
    const cards: ModelCard[] = SEEDS.flatMap((seed) => [...seed.models]);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(typeof card.id).toBe("string");
      expect(card.id.length).toBeGreaterThan(0);
      expect(Array.isArray(card.tags)).toBe(true);
      expect(card.context).toBeGreaterThan(0);
      expect(["active", "deprecated", "disabled"]).toContain(card.status);
      expect(typeof card.reasoning).toBe("boolean");
      expect(["chat-completions", "responses"]).toContain(card.callMethod);
      expect(Array.isArray(card.efforts)).toBe(true);
      expect(card.price === null || card.price.verificado === false || card.price.verificado === true).toBe(true);
      expect(typeof card.free).toBe("boolean");
    }
  });

  test("a reasoning model declares reasoning and at least one effort", () => {
    const reasoningCards = SEEDS.flatMap((seed) => [...seed.models]).filter((card) => card.reasoning);
    expect(reasoningCards.length).toBeGreaterThan(0);
    for (const card of reasoningCards) {
      expect(card.efforts.length).toBeGreaterThan(0);
    }
  });

  test("cards reach the catalog entry for the provider UI", () => {
    const entry = catalogEntry("nvidia");
    expect(entry!.cards.map((card) => card.id)).toEqual(NVIDIA_MODELS.map((card) => card.id));
  });
});
