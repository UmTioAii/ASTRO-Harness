/**
 * Classificação de paths em classes de segurança (ADR-0027, #391 slice 2).
 *
 * Classes: `hard-block` (imutável + configurável) > `sensitive` > `normal`,
 * sempre sobre o realpath (symlink resolvido via `canonicalize`), com
 * case-fold em win32/darwin e `~` expandido. Faz I/O de FS (realpath/homedir);
 * não pluga no executor; os slices seguintes consomem `classifyPath`.
 */
import * as fs from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { CRITICAL_PATH_PATTERN } from "./permissions";
import { canonicalize, isWithin, realpathPreservingDots } from "./tools/paths";

export type PathClass = "hard-block" | "sensitive" | "normal";

export interface ClassifyPathInput {
  /** Caminho a classificar (absoluto, relativo ao `cwd` ou com `~`). */
  realPath: string;
  cwd: string;
  astroHome: string;
  protectedPaths?: readonly string[];
  /** Único subtree isento do hard-block dentro de `$ASTRO_HOME` (ADR-0026). */
  artifactRoot?: string | null;
  /** Allowlist literal de `allow-critical`: realpath absoluto exato de arquivo. */
  allowCritical?: readonly string[];
}

/** Entrada de allowlist inválida (formato, glob, diretório, limite, tier imutável). */
export class AllowlistInvalidError extends Error {
  readonly code = "allow_invalid";
  constructor(readonly entry: string, message: string) {
    super(message);
    this.name = "AllowlistInvalidError";
  }
}

const MAX_ALLOW_ENTRIES = 64;
const GLOB_CHARS = /[*?[\]]/;
const SENSITIVE_SUFFIXES: readonly string[] = [".example", ".sample", ".template", ".dist"];
const KEY_SUFFIXES: readonly string[] = [".pem", ".key", ".p12", ".pfx", ".jks", ".kdbx"];
const NAMED_CONFIG_SEGMENTS: readonly string[] = ["vault.json", "auth.json", "astro.config.json"];

interface FoldedContext {
  cwd: string;
  astroHome: string;
  artifactRoot: string | null;
  protected: readonly string[];
}

/** Case-folding em win32/darwin (ADR-0027); demais plataformas preservam case. */
function fold(path: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

function expandTilde(path: string): string | null {
  const user = /^~([^\\/]*)([\\/][\s\S]*)?$/.exec(path);
  if (!user) return path;
  if (user[1] === "") return user[2] ? join(homedir(), user[2].slice(1)) : homedir();
  const info = userInfo();
  // `~usuario`: só o usuário atual resolve; os demais falham fechados (null)
  return user[1] === info.username ? join(info.homedir, user[2]?.slice(1) ?? "") : null;
}

/** Remove ADS NTFS (`arq:stream`) de cada segmento no win32, fail-closed (ADR-0027). */
function stripAds(p: string): string {
  if (process.platform !== "win32") return p;
  return p.split(sep).map((s) => (/^[a-zA-Z]:$/.test(s) ? s : s.split(":")[0])).join(sep);
}

function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

function hasAdjacentPair(segments: string[], first: string, second: string): boolean {
  return segments.some((segment, i) => segment === first && segments[i + 1] === second);
}

/** Tier imutável do hard-block (ADR-0027): sem override por allowlist. */
function isImmutableHardBlock(real: string, ctx: FoldedContext): boolean {
  const base = basename(real);
  const segments = segmentsOf(real);

  // `.env` e `.env.*`, exceto os templates (sensitive).
  if (base === ".env" || (base.startsWith(".env.") && !SENSITIVE_SUFFIXES.some((s) => base.endsWith(s)))) return true;
  // Diretórios de segredo e `.git` (qualquer profundidade, inclusive submódulos).
  if (segments.includes(".ssh") || segments.includes(".gnupg") || segments.includes(".git")) return true;
  // `.astro` do cwd e protectedPaths (comparação por segmento, nunca `startsWith`).
  if (isWithin(join(ctx.cwd, ".astro"), real)) return true;
  if (ctx.protected.some((path) => isWithin(path, real))) return true;
  // Chaves SSH e certificados por basename/sufixo.
  if (base === "id_rsa" || base === "id_ed25519") return true;
  if (KEY_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  // `.aws/credentials` e `.kube/config`.
  if (hasAdjacentPair(segments, ".aws", "credentials") || hasAdjacentPair(segments, ".kube", "config")) return true;
  // Configs nomeados (segmento, como CRITICAL_PATH_NAMES).
  if (NAMED_CONFIG_SEGMENTS.some((name) => segments.includes(name))) return true;
  // Dotfiles da home: ~/.netrc, ~/.npmrc, ~/.docker/config.json, ~/.config/gh/hosts.yml.
  const home = fold(canonicalize(homedir()));
  if (real === join(home, ".netrc") || real === join(home, ".npmrc")) return true;
  if (real === join(home, ".docker", "config.json")) return true;
  if (real === join(home, ".config", "gh", "hosts.yml")) return true;
  // Todo $ASTRO_HOME fora do artifactRoot (ADR-0026 isenta só esse subtree).
  if (isWithin(ctx.astroHome, real)) {
    if (!ctx.artifactRoot || !isWithin(ctx.artifactRoot, real)) return true;
  }
  return false;
}

/** Tier configurável: casa `CRITICAL_PATH_PATTERN` por segmento (referência por símbolo). */
function isConfigurableHardBlock(real: string): boolean {
  return segmentsOf(real).some((segment) => CRITICAL_PATH_PATTERN.test(segment));
}

function isSensitivePath(real: string): boolean {
  const base = basename(real);
  return base === ".env.example" || SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * Valida `allow-critical` antes de classificar (ADR-0027): entrada deve ser
 * realpath absoluto de arquivo, sem glob/diretório, até 64 entradas, e não
 * pode casar o tier imutável. Violação lança `AllowlistInvalidError`.
 */
function resolveAllowCritical(entries: readonly string[], cwd: string, ctx: FoldedContext): Set<string> {
  if (entries.length > MAX_ALLOW_ENTRIES) {
    throw new AllowlistInvalidError(
      `${entries.length} entradas`,
      `allow-critical excede o limite de ${MAX_ALLOW_ENTRIES} entradas`,
    );
  }
  const resolved = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(expandTilde(entry) ?? "")) {
      throw new AllowlistInvalidError(entry, `entrada de allow-critical sem realpath absoluto: ${entry}`);
    }
    if (GLOB_CHARS.test(entry) || entry.endsWith(sep)) {
      throw new AllowlistInvalidError(entry, `entrada de allow-critical com glob ou diretório não é permitida: ${entry}`);
    }
    const real = stripAds(fold(realpathPreservingDots(expandTilde(entry) ?? "", resolve(cwd))));
    try {
      if (fs.statSync(real).isDirectory()) {
        throw new AllowlistInvalidError(entry, `entrada de allow-critical é um diretório: ${entry}`);
      }
    } catch (error) {
      if (error instanceof AllowlistInvalidError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      // só ENOENT/ENOTDIR é "inexistente aceito"; outro erro falha fechado (allow_invalid)
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new AllowlistInvalidError(entry, `entrada de allow-critical não inspecionável: ${entry}`);
    }
    if (isImmutableHardBlock(real, ctx)) {
      throw new AllowlistInvalidError(entry, `entrada de allow-critical casa o tier imutável (sem override): ${entry}`);
    }
    resolved.add(real);
  }
  return resolved;
}

/** Contexto de classificação reutilizável (sem `realPath`). */
export interface PathClassifierContext {
  cwd: string;
  astroHome: string;
  protectedPaths?: readonly string[];
  artifactRoot?: string | null;
  allowCritical?: readonly string[];
}

export type PathClassifier = (realPath: string) => PathClass;

/** Fábrica: hoist do `FoldedContext`+allow; mesma semântica de `classifyPath`. */
export function createPathClassifier(input: PathClassifierContext): PathClassifier {
  const ctx: FoldedContext = {
    cwd: fold(canonicalize(resolve(input.cwd))),
    astroHome: fold(canonicalize(resolve(input.astroHome))),
    artifactRoot: input.artifactRoot ? fold(canonicalize(resolve(input.artifactRoot))) : null,
    protected: (input.protectedPaths ?? []).map((path) => fold(canonicalize(resolve(input.cwd, expandTilde(path) ?? path)))),
  };
  const allow = resolveAllowCritical(input.allowCritical ?? [], input.cwd, ctx);
  const base = resolve(input.cwd);
  return (realPath: string): PathClass => {
    const expanded = expandTilde(realPath);
    if (expanded === null) return "hard-block"; // `~usuario` não resolvido: fail-closed
    const real = stripAds(fold(realpathPreservingDots(expanded, base)));
    if (isImmutableHardBlock(real, ctx)) return "hard-block";
    if (isConfigurableHardBlock(real)) return allow.has(real) ? "normal" : "hard-block";
    if (isSensitivePath(real)) return "sensitive";
    return "normal";
  };
}

/**
 * Prefiltro léxico da varredura no cwd: true = candidato a hard-block e vai
 * para a classificação completa (falso-positivo só custa 1 classify a mais).
 */
export function createLexicalHardBlockPrefilter(
  input: Pick<PathClassifierContext, "cwd" | "astroHome" | "protectedPaths">,
): (lexicalPath: string) => boolean {
  const cwd = fold(canonicalize(resolve(input.cwd)));
  const astroHome = fold(canonicalize(resolve(input.astroHome)));
  const astroDir = join(cwd, ".astro");
  const protectedAbs = (input.protectedPaths ?? []).map((path) =>
    fold(canonicalize(resolve(input.cwd, expandTilde(path) ?? path))),
  );
  // Bases léxicas: a varredura gera paths sob `resolve(cwd)`, que pode ser
  // symlink/junction — nesse caso as bases reais não casam com os léxicos.
  const cwdLex = fold(resolve(input.cwd));
  const astroDirLex = join(cwdLex, ".astro");
  const astroHomeLex = fold(resolve(input.astroHome));
  const protectedLex = (input.protectedPaths ?? []).map((path) => fold(resolve(input.cwd, expandTilde(path) ?? path)));
  return (lexicalPath: string): boolean => {
    const p = fold(lexicalPath);
    const base = basename(p);
    const segments = segmentsOf(p);
    if (base === ".env" || (base.startsWith(".env.") && !SENSITIVE_SUFFIXES.some((s) => base.endsWith(s)))) return true;
    if (base === ".env.example" || SENSITIVE_SUFFIXES.some((s) => base.endsWith(s))) return true;
    if (segments.includes(".ssh") || segments.includes(".gnupg") || segments.includes(".git")) return true;
    if (base === "id_rsa" || base === "id_ed25519") return true;
    if (KEY_SUFFIXES.some((s) => base.endsWith(s))) return true;
    if (hasAdjacentPair(segments, ".aws", "credentials") || hasAdjacentPair(segments, ".kube", "config")) return true;
    if (NAMED_CONFIG_SEGMENTS.some((name) => segments.includes(name))) return true;
    if (segments.some((segment) => CRITICAL_PATH_PATTERN.test(segment))) return true;
    if (base === ".netrc" || base === ".npmrc") return true;
    if (hasAdjacentPair(segments, ".docker", "config.json")) return true;
    if (segments.includes(".config") && segments.includes("gh") && base === "hosts.yml") return true;
    if (isWithin(astroDir, p) || isWithin(astroDirLex, p)) return true;
    if (isWithin(astroHome, p) || isWithin(astroHomeLex, p)) return true;
    return protectedAbs.some((prot) => isWithin(prot, p)) || protectedLex.some((prot) => isWithin(prot, p));
  };
}

/** Classifica sobre o realpath; `allow-critical` só reclassifica o tier configurável. */
export function classifyPath(input: ClassifyPathInput): PathClass {
  return createPathClassifier(input)(input.realPath);
}
