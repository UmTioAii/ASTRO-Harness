import { expect, test } from "bun:test";
import { join } from "node:path";
import { profilesPath } from "../src/providers/profiles";
import { TEST_ASTRO_HOME } from "./setup";

// Exact match, not a substring: a file that times out mid-scenario leaves
// ASTRO_HOME at `…/.astro/eval-home`. This is an early canary, not a full-suite
// guarantee: it runs after `eval-harness` (the known leaker) and before the
// provider/TUI/vault tests, so those no longer absorb that leak (#656).
test("the suite starts with a clean temporary ASTRO_HOME", () => {
  const home = process.env.ASTRO_HOME;
  expect(home).toBe(TEST_ASTRO_HOME);
  expect(home).not.toContain("eval-home");
  expect(profilesPath()).toBe(join(TEST_ASTRO_HOME, "providers.json"));
});

// A host-exported override would change the config layer for the whole suite
// and make the canary above report a leak that never happened (#656).
test("the preload clears host overrides that would change the suite", () => {
  expect(process.env.ASTRO_NO_GLOBAL_CONFIG).toBeUndefined();
});
