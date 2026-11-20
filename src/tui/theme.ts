/** Estado da TUI (T2): tema global em `$ASTRO_HOME/tui.json`, override por projeto (#468). */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { astroHomePath } from "../astro-home";
import { ConfigError } from "../core/config";
import { globalTuiConfigPath, projectTuiConfigPath } from "../home-layout";

export type Theme = "dark" | "light" | "contrast";

/** Temas na ordem em que `/theme` lista e o keybind alterna (#64). */
export const THEMES: readonly Theme[] = ["dark", "light", "contrast"];

/** Guarda de tema para o argumento de `/theme` (puro). */
export function isTheme(value: string): value is Theme {
  return THEMES.some((theme) => theme === value);
}

export interface TuiConfig {
  theme: Theme;
  lastModel?: string;
  favoriteModels?: string[];
  recentModels?: string[];
}

export type ThemeColors = { accent: string; warning: string; error: string };

const DEFAULT_CONFIG: TuiConfig = { theme: "dark" };

/** Garante que o alvo existente fica dentro do `$ASTRO_HOME` canônico, seguindo links (I-11). */
function assertInsideHome(home: string, path: string): void {
  const rel = relative(realpathSync(home), realpathSync(path));
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new ConfigError("estado da TUI fora do $ASTRO_HOME");
  }
}

function normalizeList(value: unknown, max = Number.POSITIVE_INFINITY): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** Só os campos válidos do arquivo; inválido é ausente, nunca erro (leitura tolerante). */
function parseLayer(parsed: unknown): Partial<TuiConfig> {
  if (parsed === null || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  const theme = typeof record.theme === "string" && isTheme(record.theme) ? record.theme : undefined;
  const lastModel = typeof record.lastModel === "string" && record.lastModel !== "" ? record.lastModel : undefined;
  const favoriteModels = normalizeList(record.favoriteModels);
  const recentModels = normalizeList(record.recentModels, 10);
  return {
    ...(theme === undefined ? {} : { theme }),
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(favoriteModels.length === 0 ? {} : { favoriteModels }),
    ...(recentModels.length === 0 ? {} : { recentModels }),
  };
}

/** Uma camada do arquivo; ausente, inválida ou fora do `$ASTRO_HOME` vale como vazia. */
function readLayer(path: string, home: string): Partial<TuiConfig> {
  try {
    if (!existsSync(path)) return {};
    assertInsideHome(home, path);
    return parseLayer(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return {};
  }
}

/** Precedência: override do projeto > global (`$ASTRO_HOME/tui.json`) > default. */
export function loadTuiConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): TuiConfig {
  const home = astroHomePath(env);
  const global = readLayer(globalTuiConfigPath(env), home);
  const project = readLayer(projectTuiConfigPath(cwd, env), home);
  const lastModel = project.lastModel ?? global.lastModel;
  const favoriteModels = project.favoriteModels ?? global.favoriteModels;
  const recentModels = project.recentModels ?? global.recentModels;
  return {
    theme: project.theme ?? global.theme ?? "dark",
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(favoriteModels === undefined ? {} : { favoriteModels }),
    ...(recentModels === undefined ? {} : { recentModels }),
  };
}

/**
 * Grava o override do projeto mesclando com o que ele já tem (o tema global
 * nunca é copiado para cá). Estado é privado: diretório 0700, arquivo 0600.
 */
export function saveTuiConfig(cwd: string, config: Partial<TuiConfig>, env: NodeJS.ProcessEnv = process.env): void {
  const home = astroHomePath(env);
  const file = projectTuiConfigPath(cwd, env);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertInsideHome(home, dir);
  if (existsSync(file)) assertInsideHome(home, file);
  const current = readLayer(file, home);
  const lastModel = config.lastModel ?? current.lastModel;
  const favoriteModels = config.favoriteModels === undefined
    ? current.favoriteModels
    : normalizeList(config.favoriteModels);
  const recentModels = config.recentModels === undefined
    ? current.recentModels
    : normalizeList(config.recentModels, 10);
  const merged: Partial<TuiConfig> = {
    theme: config.theme ?? current.theme,
    ...(lastModel === undefined ? {} : { lastModel }),
    ...(favoriteModels === undefined || favoriteModels.length === 0 ? {} : { favoriteModels }),
    ...(recentModels === undefined || recentModels.length === 0 ? {} : { recentModels }),
  };
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Próximo tema do ciclo (`ctrl+x t`): dark -> light -> contrast -> dark. */
export function nextTheme(theme: Theme): Theme {
  const index = THEMES.indexOf(theme);
  return THEMES[(index + 1) % THEMES.length]!;
}

/** Cores por tema; o fundo do terminal não é alterado. */
export function getThemeColors(theme: Theme): ThemeColors {
  if (theme === "contrast") return { accent: "whiteBright", warning: "yellowBright", error: "redBright" };
  return { accent: theme === "light" ? "blue" : "cyan", warning: "yellow", error: "red" };
}
