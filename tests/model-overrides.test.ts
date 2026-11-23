import { describe, expect, test } from "bun:test";
import { MODEL_FACTS, type ModelFacts } from "../src/models/catalog";
import {
  ModelOverrideError,
  cardFor,
  overrideNotes,
  type OverrideNote,
} from "../src/models/overrides";
import { composeEntry } from "../src/providers/catalog";
import { effectiveCard, type ProviderAdapterSeed } from "../src/providers/seed";

function card(overrides: Partial<ModelFacts>): ReturnType<typeof effectiveCard> {
  return effectiveCard({ ref: "gpt-5.5", price: null, free: false, overrides });
}

function rejected(run: () => unknown): ModelOverrideError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelOverrideError);
    return error as ModelOverrideError;
  }
  throw new Error("expected the malformed override to be rejected");
}

function note(notes: readonly OverrideNote[], field: string): OverrideNote {
  const found = notes.find((item) => item.field === field);
  if (found === undefined) throw new Error(`missing note for ${field}`);
  return found;
}

describe("provider override validation (#625)", () => {
  test("reasoning true requires at least one effort level", () => {
    const error = rejected(() => card({ reasoning: true, efforts: [] }));
    expect(error.field).toBe("efforts");
    expect(error.message).toContain("gpt-5.5.efforts");
  });

  test("context and maxOutput must be positive", () => {
    expect(rejected(() => card({ context: 0 })).field).toBe("context");
    expect(rejected(() => card({ context: -1 })).field).toBe("context");
    expect(rejected(() => card({ maxOutput: 0 })).field).toBe("maxOutput");
    expect(rejected(() => card({ maxOutput: -1 })).field).toBe("maxOutput");
  });

  test("a declared output cap cannot exceed the resolved context", () => {
    const error = rejected(() => card({ maxOutput: MODEL_FACTS["gpt-5.5"].context + 1 }));
    expect(error.field).toBe("maxOutput");
  });

  test("narrowing the context clamps the inherited cap instead of failing", () => {
    const narrower = card({ context: 64_000, reasoning: false, efforts: [] });
    expect(narrower.maxOutput).toBe(64_000);
    expect(narrower.maxOutput).toBeLessThanOrEqual(narrower.context);
  });
});

describe("override notes (#625)", () => {
  test("each overridden fact names the effective and the catalog value", () => {
    const notes = overrideNotes(card({ context: 64_000, reasoning: false, efforts: [], tags: ["fast"] }));
    expect(note(notes, "context")).toEqual({
      field: "context",
      effective: "64000",
      catalog: String(MODEL_FACTS["gpt-5.5"].context),
    });
    // The inherited output cap changed too, even without an explicit override.
    expect(note(notes, "maxOutput").effective).toBe("64000");
    expect(note(notes, "reasoning").effective).toBe("false");
    expect(note(notes, "tags").effective).toBe("fast");
    expect(note(notes, "tags").catalog).toBe(MODEL_FACTS["gpt-5.5"].tags.join(","));
  });

  test("a card without overrides has no notes", () => {
    expect(overrideNotes(effectiveCard({ ref: "meta/llama-3.3-70b-instruct", price: null, free: false })))
      .toEqual([]);
  });

  test("a malformed offer is recorded at composition instead of crashing startup", () => {
    const seed: ProviderAdapterSeed = {
      key: "demo",
      name: "Demo",
      kind: "openai-compat",
      models: [
        { ref: "gpt-5.5", price: null, free: false, overrides: { reasoning: true, efforts: [] } },
        { ref: "meta/llama-3.3-70b-instruct", price: null, free: false },
      ],
    };
    const entry = composeEntry(seed);
    expect(entry.cards.map((item) => item.id)).toEqual(["meta/llama-3.3-70b-instruct"]);
    expect(entry.overrideErrors?.map((error) => error.field)).toEqual(["efforts"]);
  });

  test("cardFor splits provider from a model id that contains slashes", () => {
    const entry = composeEntry({ key: "nvidia", name: "NVIDIA", kind: "openai-compat", models: [
      { ref: "meta/llama-3.3-70b-instruct", price: null, free: false },
    ] });
    expect(cardFor("nvidia/meta/llama-3.3-70b-instruct", [entry])?.id).toBe("meta/llama-3.3-70b-instruct");
    expect(cardFor("nvidia/missing", [entry])).toBeUndefined();
    expect(cardFor("no-slash", [entry])).toBeUndefined();
  });
});
