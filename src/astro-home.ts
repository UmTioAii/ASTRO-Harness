import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Effective `$ASTRO_HOME`. A relative value resolves against the process cwd,
 * so every state path is absolute: Windows applies MAX_PATH to the unresolved
 * `cwd + relative` string and fails a long relative path even when the
 * resolved target is writable (#692).
 */
export function astroHomePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ASTRO_HOME?.trim();
  if (home === undefined || home === "") return join(homedir(), ".astro");
  return resolve(home);
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "config.json");
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "state.json");
}
