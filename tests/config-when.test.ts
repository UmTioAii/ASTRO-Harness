import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/core/config";

/** Minimal config with two providers/models so a matcher has something to point at. */
function config(agents: Record<string, unknown>) {
  return validateConfig({
    providers: {
      p1: { kind: "openai-compat", baseUrl: "http://p1/v1", credentialRef: "KEY1" },
      p2: { kind: "openai-compat", baseUrl: "http://p2/v1", credentialRef: "KEY2" },
    },
    models: [
      { provider: "p1", id: "m1", tags: ["writing-code", "tools"], context: 8192, capabilities: { tools: true } },
      { provider: "p2", id: "m2", tags: ["review", "tools"], context: 8192, capabilities: { tools: true } },
    ],
    agent: { model: "p1/m1", maxSteps: 5, tools: ["handoff"] },
    agents,
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

describe("agents.<name>.when (#602)", () => {
  test("accepts the closed matcher shape and keeps it on the named agent", () => {
    const cfg = config({
      planner: { model: "p1/m1" },
      scout: { model: "p2/m2", when: { tags: ["tools"], provider: "p2", model: "p2/m2" } },
    });
    expect(cfg.agents?.scout?.when).toEqual({ tags: ["tools"], provider: "p2", model: "p2/m2" });
  });

  test("refuses an unknown matcher key instead of ignoring it", () => {
    expect(() => config({ scout: { model: "p1/m1", when: { turn: "plan" } } })).toThrow(/when/);
  });

  test("refuses a tag outside the closed vocabulary", () => {
    expect(() => config({ scout: { model: "p1/m1", when: { tags: ["quick"] } } })).toThrow(/tags/);
  });

  test("refuses an undeclared or inactive provider/model reference", () => {
    expect(() => config({ scout: { model: "p1/m1", when: { provider: "p9" } } })).toThrow(/provider/);
    expect(() => config({ scout: { model: "p1/m1", when: { model: "p9/m9" } } })).toThrow(/model/);
    expect(() => config({ scout: { model: "p1/m1", when: { provider: "p2", model: "p1/m1" } } })).toThrow(/provider/);
  });

  test("refuses a matcher without a predicate, which would fire on every turn", () => {
    expect(() => config({ scout: { model: "p1/m1", when: {} } })).toThrow(/when/);
  });
});
