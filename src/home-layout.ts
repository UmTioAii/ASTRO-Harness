/** Layout do estado em `$ASTRO_HOME` (#468, S2 de #401); ver `docs/astro-home-layout.md`. */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { astroHomePath } from "./astro-home";

/**
 * Teto de bytes de uma chave de projeto: abaixo dos 255 bytes de um nome de
 * diretório, para que qualquer arquivo de estado caiba dentro da chave.
 */
export const PROJECT_KEY_MAX_BYTES = 120;

/** Skill do usuário: `$ASTRO_HOME/skills` — nem `homedir()` nem o cwd decidem a raiz. */
export function skillsUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "skills");
}

/** Caminho do projeto canônico: absoluto, com `/` e caixa dobrada no win32 (mesmo diretório, mesma chave). */
export function canonicalProjectPath(projectPath: string): string {
  const absolute = resolve(projectPath).replaceAll("\\", "/");
  const withoutTrailing = absolute.length > 1 ? absolute.replace(/\/+$/u, "") : absolute;
  return process.platform === "win32" ? withoutTrailing.toLowerCase() : withoutTrailing;
}

/**
 * Nome de diretório injetivo para o caminho: `_s` é o separador e `_x<hex>` é
 * cada byte UTF-8 fora de `[A-Za-z0-9.-]` (inclusive `_`). Sem ambiguidade,
 * então dois projetos jamais caem na mesma chave.
 */
function encodeProjectPath(canonical: string): string {
  let key = "";
  for (const char of canonical) {
    if (/^[A-Za-z0-9.-]$/u.test(char)) {
      key += char;
    } else if (char === "/") {
      key += "_s";
    } else {
      for (const byte of Buffer.from(char, "utf8")) key += `_x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return key;
}

/**
 * Chave estável do projeto: o caminho legível e, só quando passaria do teto de
 * bytes, `sha256-<32 hex>` do caminho canônico (determinístico e documentado).
 */
export function projectKey(projectPath: string): string {
  const canonical = canonicalProjectPath(projectPath);
  const readable = encodeProjectPath(canonical);
  if (Buffer.byteLength(readable, "utf8") <= PROJECT_KEY_MAX_BYTES) return readable;
  return `sha256-${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`;
}

/** Estado do projeto: `$ASTRO_HOME/projects/<chave>`. */
export function projectDataDir(projectPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "projects", projectKey(projectPath));
}

/** Skills do projeto: `$ASTRO_HOME/projects/<chave>/skills`. */
export function projectSkillsRoot(projectPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectDataDir(projectPath, env), "skills");
}

/** Tema e preferências globais da TUI: `$ASTRO_HOME/tui.json`. */
export function globalTuiConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "tui.json");
}

/** Override do projeto para o estado da TUI: `$ASTRO_HOME/projects/<chave>/tui.json`. */
export function projectTuiConfigPath(projectPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(projectDataDir(projectPath, env), "tui.json");
}
