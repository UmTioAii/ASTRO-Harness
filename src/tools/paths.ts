import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ToolError } from "./types";

const RESERVED_DIR = ".astro";

export function canonicalize(target: string, seen = new Set<string>()): string {
  let current = resolve(target);
  const suffix: string[] = [];

  // `realpath` só funciona em caminhos existentes. Para escrita, sobe até o
  // ancestral existente mais próximo e recompõe o restante. Se o próprio
  // componente for um symlink/junction pendente, `realpath` falha com ENOENT;
  // nesse caso resolvemos o link manualmente para não tratá-lo como literal.
  while (true) {
    try {
      return resolve(realpathSync.native(current), ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      let linkTarget: string | undefined;
      try {
        if (lstatSync(current).isSymbolicLink()) {
          if (seen.has(current)) {
            throw new ToolError(`ciclo de symlink: ${current}`);
          }
          seen.add(current);
          linkTarget = readlinkSync(current);
        }
      } catch (linkError) {
        const linkCode = (linkError as NodeJS.ErrnoException).code;
        if (linkCode !== "ENOENT" && linkCode !== "ENOTDIR") throw linkError;
      }

      if (linkTarget !== undefined) {
        const resolvedTarget = isAbsolute(linkTarget)
          ? linkTarget
          : resolve(dirname(current), linkTarget);
        return resolve(canonicalize(resolvedTarget, seen), ...suffix.reverse());
      }

      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Como `canonicalize`, mas preserva `..` até o realpath (I-11): cada segmento
 * resolve sobre o caminho já real, então `x/../.netrc` com `x` junction para
 * `$HOME/AppData` cai no `~/.netrc` real, não em `cwd/.netrc`.
 */
export function realpathPreservingDots(target: string, cwd: string): string {
  const raw = isAbsolute(target) ? target : cwd + sep + target;
  const root = parse(raw).root;
  let current = root;
  for (const part of raw.slice(root.length).split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    current = part === ".." ? dirname(current) : canonicalize(join(current, part));
  }
  return current;
}

export function isWithin(root: string, target: string): boolean {
  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(comparableRoot, comparableTarget);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/**
 * Resolve `p` relativo a `cwd` e garante que o resultado fica dentro de `cwd`.
 * A checagem usa o caminho real, então symlinks/junctions não escapam do cwd.
 * Lança `ToolError` (mensagem com "fora") para `../` e caminhos absolutos externos.
 */
export function resolveWithin(cwd: string, p: string): string {
  const root = resolve(cwd);
  const target = resolve(root, p);
  if (!isWithin(canonicalize(root), canonicalize(target))) {
    throw new ToolError(`caminho fora do diretório de trabalho: ${p}`);
  }
  return target;
}

/**
 * Confinamento de um alvo derivado (I-11, #532): ao contrário de
 * `resolveWithin`, o caminho não vem do input do modelo - já foi calculado sob
 * `root` (cwd para a memória do projeto, `$ASTRO_HOME` para a global). A
 * checagem existe porque o realpath ainda pode sair da raiz por symlink ou
 * junction, e porque `protectedPaths` (ledger/audit) nunca são sobrescritos.
 * Lança `ToolError` sem citar conteúdo (I-03).
 */
export function assertConfinedPath(
  root: string,
  target: string,
  protectedPaths: readonly string[] = [],
): string {
  const canonicalRoot = canonicalize(root);
  const canonicalTarget = canonicalize(target);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new ToolError("caminho reservado do harness: alvo fora da raiz permitida");
  }
  const protectedTargets = protectedPaths.map((path) => canonicalize(resolve(root, path)));
  if (protectedTargets.some((path) => isWithin(path, canonicalTarget))) {
    throw new ToolError("caminho reservado do harness: Auditoria/ledger não são memória");
  }
  return target;
}

/**
 * Como `resolveWithin`, mas também recusa o diretório de estado do harness.
 * O agente pode ler o workspace, porém não pode sobrescrever auditoria/ledger.
 */
export function resolveWritableWithin(
  cwd: string,
  p: string,
  protectedPaths: readonly string[] = [],
): string {
  const target = resolveWithin(cwd, p);
  const canonicalTarget = canonicalize(target);
  const reserved = [
    resolve(cwd, RESERVED_DIR),
    ...protectedPaths.map((path) => resolve(cwd, path)),
  ];
  if (reserved.some((path) => isWithin(canonicalize(path), canonicalTarget))) {
    throw new ToolError(`caminho reservado do harness: ${p}`);
  }
  return target;
}
