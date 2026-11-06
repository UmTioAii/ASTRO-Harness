/**
 * Allowlists de path SÓ de flag de CLI (ADR-0027, #391 s5a): nada lê config/arquivo.
 * Validadas fail-closed ANTES do run; `allow-sensitive` inválida é ignorada com aviso+audit.
 */
import { statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { AllowlistInvalidError, classifyPath } from "./path-class";
import { resolveArtifactRoot, resolveAstroHome } from "./permissions";
import { realpathPreservingDots } from "./tools/paths";
/** Teto de entradas por allowlist (ADR-0027). */
export const MAX_ALLOWLIST_ENTRIES = 64;
const GLOB_CHARS = /[*?[\]]/;
const fold = (value: string): string => process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
/** Nomes/folhas do tier imutável usados para invalidar globs amplos de `allow-sensitive` (ADR-0027). */
const HARD_BLOCK_LEAVES = [".env", ".env.local", ".ssh", ".gnupg", ".git", ".aws", ".kube", ".astro", "id_rsa", "id_ed25519", "vault.json", "auth.json", "astro.config.json", "config.json", "credentials", "hosts.yml", "x.pem", "x.key", "x.p12", "x.pfx", "x.jks", "x.kdbx", ".netrc", ".npmrc"];
/** Flags cruas coletadas pelo parser de CLI (só run/chat/tui). */
export interface AllowlistFlags {
  allowCriticalRaw: string[];
  allowSensitiveRaw: string[];
  iUnderstand: boolean;
}
/** Evento de auditoria de load: entrada + resultado, sem conteúdo (I-03). */
export interface AllowlistLoadEvent {
  entry: string;
  result: "applied" | "ignored" | "invalid";
  origin: "cli";
  rule: "allow-critical" | "allow-sensitive";
}
export interface CliAllowlists {
  allowCritical: string[];
  allowSensitive: string[];
  events: AllowlistLoadEvent[];
}
interface Ctx {
  cwd: string;
  astroHome: string;
  artifactRoot: string | null;
}
function ctxOf(cwd: string): Ctx {
  return { cwd: resolve(cwd), astroHome: resolve(resolveAstroHome()), artifactRoot: resolveArtifactRoot() };
}
/** `~`/`~usuario` como em `classifyPath`; demais falham fechados. */
function expandTilde(path: string): string | null {
  const user = /^~([^\\/]*)([\\/][\s\S]*)?$/.exec(path);
  if (!user) return path;
  if (user[1] === "") return user[2] ? join(homedir(), user[2].slice(1)) : homedir();
  const info = userInfo();
  return user[1] === info.username ? join(info.homedir, user[2]?.slice(1) ?? "") : null;
}
function classify(realPath: string, c: Ctx, allowCritical?: readonly string[]) {
  return classifyPath({ realPath, cwd: c.cwd, astroHome: c.astroHome, artifactRoot: c.artifactRoot, ...(allowCritical === undefined ? {} : { allowCritical }) });
}
function existsFile(path: string, cwd: string): boolean {
  try {
    statSync(resolve(cwd, expandTilde(path) ?? path));
    return true;
  } catch {
    return false;
  }
}
/** `applied` = libera o tier configurável; senão é ignorada (aviso). */
function criticalResult(real: string, c: Ctx): "applied" | "ignored" {
  return classify(real, c) === "hard-block" ? "applied" : "ignored";
}
/** Glob amplo que pode cobrir uma folha do tier imutável invalida a entrada inteira. */
function globMayHitHardBlock(entry: string): boolean {
  const glob = new Bun.Glob(fold(basename(entry)));
  return HARD_BLOCK_LEAVES.some((name) => glob.match(fold(name)));
}

/** Fail-closed: casa hard-block, glob amplo ou literal inexistente → `ignored`. */
function sensitiveResult(entry: string, c: Ctx): "applied" | "ignored" {
  if (GLOB_CHARS.test(entry) && globMayHitHardBlock(entry)) return "ignored";
  if (classify(entry, c) === "hard-block") return "ignored";
  if (!GLOB_CHARS.test(entry) && !existsFile(entry, c.cwd)) return "ignored";
  return "applied";
}
/** Valida uma entrada de `allow-critical`; devolve o realpath resolvido. */
function validateCriticalEntry(entry: string, c: Ctx): string {
  const expanded = expandTilde(entry);
  if (expanded === null || entry.length === 0 || !isAbsolute(expanded)) {
    throw new AllowlistInvalidError(entry, `entrada de allow-critical sem realpath absoluto: ${entry}`);
  }
  if (GLOB_CHARS.test(entry) || entry.endsWith(sep)) {
    throw new AllowlistInvalidError(entry, `entrada de allow-critical com glob ou diretório não é permitida: ${entry}`);
  }
  let isFile = false;
  try {
    isFile = statSync(expanded).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new AllowlistInvalidError(entry, `entrada de allow-critical não inspecionável: ${entry}`);
    }
  }
  if (!isFile) throw new AllowlistInvalidError(entry, `entrada de allow-critical não é arquivo existente: ${entry}`);
  const real = realpathPreservingDots(expanded, c.cwd);
  // Tier imutável não tem override: hard-block com e sem allow.
  if (classify(real, c) === "hard-block" && classify(real, c, [real]) === "hard-block") {
    throw new AllowlistInvalidError(entry, `entrada de allow-critical casa o tier imutável (sem override): ${entry}`);
  }
  return real;
}
/** Valida as flags de allowlist de run/chat/tui (ADR-0027). `allow-critical` sem `--i-understand` na MESMA invocação → `allow_invalid`. */
export function validateAllowlistFlags(flags: AllowlistFlags, cwd: string): CliAllowlists {
  const c = ctxOf(cwd);
  if (flags.allowCriticalRaw.length > 0 && !flags.iUnderstand) {
    throw new AllowlistInvalidError(flags.allowCriticalRaw[0] ?? "--allow-critical", "allow_invalid: --allow-critical exige --i-understand na mesma invocação");
  }
  if (flags.allowCriticalRaw.length > MAX_ALLOWLIST_ENTRIES || flags.allowSensitiveRaw.length > MAX_ALLOWLIST_ENTRIES) {
    throw new AllowlistInvalidError(`${Math.max(flags.allowCriticalRaw.length, flags.allowSensitiveRaw.length)} entradas`, `allowlist excede o limite de ${MAX_ALLOWLIST_ENTRIES} entradas por flag`);
  }
  const events: AllowlistLoadEvent[] = [];
  const allowCritical = flags.allowCriticalRaw.map((entry) => {
    const real = validateCriticalEntry(entry, c);
    events.push({ entry: real, result: criticalResult(real, c), origin: "cli", rule: "allow-critical" });
    return real;
  });
  const allowSensitive: string[] = [];
  for (const entry of flags.allowSensitiveRaw) {
    const result = sensitiveResult(entry, c);
    events.push({ entry, result, origin: "cli", rule: "allow-sensitive" });
    if (result === "applied") allowSensitive.push(entry);
  }
  return { allowCritical, allowSensitive, events };
}
/** Re deriva os eventos de load das allowlists já validadas, sem lançar — o run emite `security.allowlist_applied` por entrada no load. */
export function allowlistLoadEvents(allowlists: { allowCritical?: readonly string[]; allowSensitive?: readonly string[] }, cwd: string): AllowlistLoadEvent[] {
  const c = ctxOf(cwd);
  return [
    ...(allowlists.allowCritical ?? []).map((entry) => ({ entry, result: criticalResult(entry, c), origin: "cli", rule: "allow-critical" })),
    ...(allowlists.allowSensitive ?? []).map((entry) => ({ entry, result: sensitiveResult(entry, c), origin: "cli", rule: "allow-sensitive" })),
  ] as AllowlistLoadEvent[];
}
