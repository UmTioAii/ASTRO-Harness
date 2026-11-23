import { describe, expect, test } from "bun:test";
import { estimateCost } from "../src/ledger";
import { MODEL_FACTS, isModelId, modelFacts, type ModelId } from "../src/models/catalog";
import { priceLabel } from "../src/pricing";
import { CODEX_MODELS } from "../src/providers/codex/codex_models";
import { NVIDIA_MODELS } from "../src/providers/nvidia/nvidia_models";
import { OPENROUTER_MODELS } from "../src/providers/openrouter/openrouter_models";
import { effectiveCard, type ProviderModel } from "../src/providers/seed";
import { isKnownTag } from "../src/tags";

const OFFERS: readonly ProviderModel[] = [...NVIDIA_MODELS, ...OPENROUTER_MODELS, ...CODEX_MODELS];

describe("model catalog facts (#601)", () => {
  test("an unknown or misspelled model id does not compile", () => {
    // @ts-expect-error - `gpt-5.6` is not a curated catalog id
    const typo: ModelId = "gpt-5.6";
    expect(String(typo)).toBe("gpt-5.6");
    // @ts-expect-error - an offer may only point at a curated catalog id
    const typoOffer: ProviderModel = { ref: "gpt-5.6", price: null, free: false };
    expect(String(typoOffer.ref)).toBe("gpt-5.6");
    expect(isModelId("gpt-5.5")).toBe(true);
    expect(isModelId("gpt-5.6")).toBe(false);
  });

  test("every provider offer points at a curated fact", () => {
    for (const offer of OFFERS) {
      expect(isModelId(offer.ref)).toBe(true);
      expect(modelFacts(offer.ref).context).toBeGreaterThan(0);
      // Effective cards, not only catalog facts, stay inside the vocabulary.
      for (const tag of effectiveCard(offer).tags) expect(isKnownTag(tag)).toBe(true); // I-21
    }
  });

  test("an override cannot introduce a tag outside the vocabulary", () => {
    // @ts-expect-error - `tool` is not a curated tag
    const bad: ProviderModel = { ref: "gpt-5.5", price: null, free: false, overrides: { tags: ["tool"] } };
    expect(bad.ref).toBe("gpt-5.5");
    expect(effectiveCard({ ref: "gpt-5.5", price: null, free: false, overrides: { tags: ["tools"] } }).tags)
      .toEqual(["tools"]);
  });

  test("facts own context, output limit, tools, modalities and curated tags", () => {
    for (const facts of Object.values(MODEL_FACTS)) {
      expect(facts.context).toBeGreaterThan(0);
      expect(facts.maxOutput).toBeGreaterThan(0);
      expect(facts.maxOutput).toBeLessThanOrEqual(facts.context);
      expect(facts.modalities.input.length).toBeGreaterThan(0);
      expect(facts.modalities.output).toContain("text");
      for (const tag of facts.tags) expect(isKnownTag(tag)).toBe(true); // I-21
      if (facts.reasoning) expect(facts.efforts.length).toBeGreaterThan(0);
      else expect(facts.efforts).toHaveLength(0);
    }
  });

  test("one fact shared by two providers follows the catalog entry", () => {
    const first = effectiveCard({ ref: "gpt-5.5", price: null, free: false });
    const second = effectiveCard({ ref: "gpt-5.5", price: null, free: false, callMethod: "responses" });
    expect(first.context).toBe(MODEL_FACTS["gpt-5.5"].context);
    expect(second.context).toBe(MODEL_FACTS["gpt-5.5"].context);
    expect(first.tags).toEqual([...MODEL_FACTS["gpt-5.5"].tags]);
    expect(second.tags).toEqual([...MODEL_FACTS["gpt-5.5"].tags]);
    expect(first.id).toBe(second.id);
    // Offer defaults keep the previous card behavior.
    expect(first.status).toBe("active");
    expect(first.callMethod).toBe("chat-completions");
    expect(second.callMethod).toBe("responses");
  });

  test("maxOutput stays within the effective context", () => {
    const narrower = effectiveCard({
      ref: "gpt-5.5", price: null, free: false, overrides: { context: 64000, reasoning: false, efforts: [] },
    });
    expect(narrower.context).toBe(64000);
    expect(narrower.maxOutput).toBe(64000);
    expect(narrower.maxOutput).toBeLessThanOrEqual(narrower.context);
    // Facts the provider did not override still come from the catalog.
    expect(narrower.efforts).toEqual([]);
    expect(narrower.tags).toEqual([...MODEL_FACTS["gpt-5.5"].tags]);

    const wider = effectiveCard({
      ref: "meta/llama-3.3-70b-instruct", price: null, free: false, overrides: { context: 262144 },
    });
    expect(wider.context).toBe(262144);
    expect(wider.maxOutput).toBe(MODEL_FACTS["meta/llama-3.3-70b-instruct"].maxOutput);
    expect(wider.maxOutput).toBeLessThanOrEqual(wider.context);
  });

  test("a model without a curated price stays n/d, never zero", () => {
    const nvidia = effectiveCard(NVIDIA_MODELS[0]!);
    expect(nvidia.price).toBeNull();
    expect(priceLabel(nvidia.id, nvidia.price ?? undefined)).toBe("n/d");
    expect(estimateCost(1000, 1000, nvidia.price ?? undefined)).toBeNull();

    const openrouter = effectiveCard(OPENROUTER_MODELS[0]!);
    expect(openrouter.price?.inputPerM).toBe(0.15);
    expect(priceLabel(openrouter.id, openrouter.price ?? undefined)).toContain("in 0.15/M");
  });
});
