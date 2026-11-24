import { expect, test } from "bun:test";
import { join } from "node:path";
import { profilesPath } from "../src/providers/profiles";
import { TEST_ASTRO_HOME } from "./setup";

// Exact match, not a substring: a file that times out mid-scenario leaves
// ASTRO_HOME at `…/.astro/eval-home`, and the failure must surface here, in the
// file that leaked it, instead of 14 unrelated provider/TUI/vault tests (#656).
test("the suite starts with a clean temporary ASTRO_HOME", () => {
  const home = process.env.ASTRO_HOME;
  expect(home).toBe(TEST_ASTRO_HOME);
  expect(home).not.toContain("eval-home");
  expect(process.env.ASTRO_NO_GLOBAL_CONFIG).toBeUndefined();
  expect(profilesPath()).toBe(join(TEST_ASTRO_HOME, "providers.json"));
});
