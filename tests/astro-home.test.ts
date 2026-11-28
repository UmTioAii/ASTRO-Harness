import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import { astroHomePath } from "../src/astro-home";
import { projectDataDir, skillsUserRoot } from "../src/home-layout";

describe("$ASTRO_HOME resolution (#692)", () => {
  test("a relative $ASTRO_HOME resolves against the process cwd", () => {
    expect(astroHomePath({ ASTRO_HOME: "relative/home" })).toBe(resolve("relative/home"));
  });

  test("every state path under a relative $ASTRO_HOME is absolute", () => {
    const env = { ASTRO_HOME: ".astro" };
    expect(isAbsolute(skillsUserRoot(env))).toBe(true);
    expect(isAbsolute(projectDataDir(process.cwd(), env))).toBe(true);
  });
});
