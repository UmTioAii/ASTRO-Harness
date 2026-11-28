import { describe, expect, test } from "bun:test";
import { isAbsolute, resolve } from "node:path";
import { astroHomePath, globalConfigPath, statePath } from "../src/astro-home";
import { resolveArtifactRoot } from "../src/attachments/store";
import {
  globalTuiConfigPath,
  projectDataDir,
  projectSkillsRoot,
  projectTuiConfigPath,
  skillsUserRoot,
} from "../src/home-layout";
import { resolveAstroHome } from "../src/permissions";
import { profilesPath } from "../src/providers/profiles";
import { trustStatePath } from "../src/trust";
import { vaultPath } from "../src/vault";

describe("$ASTRO_HOME resolution (#692)", () => {
  test("a relative $ASTRO_HOME resolves against the process cwd", () => {
    expect(astroHomePath({ ASTRO_HOME: "relative/home" })).toBe(resolve("relative/home"));
  });

  test("every state path under a relative $ASTRO_HOME is absolute", () => {
    const env = { ASTRO_HOME: ".astro" };
    const paths = [
      globalConfigPath(env),
      statePath(env),
      vaultPath(env),
      trustStatePath(env),
      skillsUserRoot(env),
      projectDataDir(process.cwd(), env),
      projectSkillsRoot(process.cwd(), env),
      globalTuiConfigPath(env),
      projectTuiConfigPath(process.cwd(), env),
      profilesPath(env),
      resolveArtifactRoot({ env, astroHome: resolveAstroHome(env) }),
    ];
    for (const path of paths) expect(isAbsolute(path)).toBe(true);
    expect(paths.filter((path) => !isAbsolute(path))).toEqual([]);
  });
});
