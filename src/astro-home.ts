import { homedir } from "node:os";
import { join } from "node:path";

export function astroHomePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  return home === undefined || home === "" ? join(homedir(), ".astro") : home;
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "config.json");
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "state.json");
}
