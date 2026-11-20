/** Layout do estado em `$ASTRO_HOME` (#468, S2 de #401); ver `docs/astro-home-layout.md`. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { astroHomePath } from "./astro-home";
import { foldPathCase } from "./path-class";
import { canonicalize } from "./tools/paths";

/**
 * Teto de bytes de uma chave de projeto: abaixo dos 255 bytes de um nome de
 * diretório, para que qualquer arquivo de estado caiba dentro da chave.
 */
export const PROJECT_KEY_MAX_BYTES = 120;

/** Caminho de estado que sairia do `$ASTRO_HOME` (I-11). */
export class HomeScopeError extends Error {
  readonly code = "astro_home_scope";
  constructor() {
    super("caminho de estado fora do $ASTRO_HOME");
    this.name = "HomeScopeError";
  }
}

/** Skill do usuário: `$ASTRO_HOME/skills` — nem `homedir()` nem o cwd decidem a raiz. */
export function skillsUserRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(astroHomePath(env), "skills");
}

/**
 * Caminho do projeto canônico: absoluto, separadores normalizados só onde `\` é
 * separador (win32) e caixa dobrada só onde o filesystem não a diferencia.
 */
export function canonicalProjectPath(projectPath: string): string {
  const absolute = resolve(projectPath);
  const normalized = process.platform === "win32" ? absolute.replaceAll("\\", "/") : absolute;
  const withoutTrailing = normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
  return foldPathCase(withoutTrailing);
}

/**
 * Nome de diretório injetivo para o caminho: `_s` é o separador e `_x<hex>` é
 * cada byte UTF-8 fora de `[A-Za-z0-9.-]` (inclusive `_`). O hex sempre tem dois
 * dígitos e o escape é sem ambiguidade, então dois projetos jamais caem na mesma
 * chave.
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

/**
 * `path` fica dentro de `home`, seguindo os links do ancestral existente mais
 * profundo (`canonicalize` cobre caminhos que ainda serão criados). A comparação
 * dobra caixa onde o filesystem também dobra (I-11).
 */
export function isInsideHome(home: string, path: string): boolean {
  const root = foldPathCase(canonicalize(home));
  const target = foldPathCase(canonicalize(path));
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(/[\\/]/u)[0] !== "..";
}

/** Recusa `path` fora do `$ASTRO_HOME` (`HomeScopeError`); nada é criado antes disto. */
export function assertInsideHome(home: string, path: string): void {
  if (!isInsideHome(home, path)) throw new HomeScopeError();
}

/** Cria `$ASTRO_HOME` (0700, quando criado) e devolve o caminho. */
export function ensureAstroHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = astroHomePath(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * Cria `dir` como estado privado (0700) garantindo que fica dentro de `home`
 * antes e depois do `mkdir` — um junction preexistente não escapa (I-11).
 */
export function ensureDirInside(home: string, dir: string): string {
  assertInsideHome(home, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertInsideHome(home, dir);
  return dir;
}

/** Cria diretório de estado privado (0700) sem exigir `$ASTRO_HOME` conhecido. */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
