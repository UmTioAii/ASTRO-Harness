import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createLexicalHardBlockPrefilter, createPathClassifier } from "../path-class";
import { resolveArtifactRoot, resolveAstroHome } from "../permissions";
import { isWithin } from "./paths";
import { ToolError } from "./types";

/** Caminho absoluto exibido como relativo ao cwd, sempre com "/" (nunca ecoa conteúdo). */
export function relativePath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel === "" ? "." : rel.split(sep).join("/");
}

/** Mesmo caminho real, com case-fold nas plataformas do ADR-0027. */
export function isSamePath(a: string, b: string): boolean {
  return isWithin(a, b) && isWithin(b, a);
}

export interface PathGuardContext {
  cwd: string;
  protectedPaths?: readonly string[];
  /** `allow-critical` da CLI (ADR-0027): único override do tier configurável. */
  allowCritical?: readonly string[];
}

/**
 * Piso fixo das tools destrutivas (#535): o alvo — e, quando é diretório, todo
 * descendente — não pode cair em `hard-block` (ADR-0027), matando
 * `delete_path({ path: "projeto", recursive: true })` sobre uma árvore com
 * `.env`/`protectedPaths`. Roda antes de qualquer mutação, então a recusa
 * deixa a árvore intacta. Symlink não é seguido: `Dirent.isDirectory()` é falso
 * para link, e o walk nunca sai do cwd (I-11).
 */
export function assertNoHardBlocked(target: string, ctx: PathGuardContext): void {
  const astroHome = resolveAstroHome();
  const protectedPaths = ctx.protectedPaths ?? [];
  const classifier = createPathClassifier({
    cwd: ctx.cwd,
    astroHome,
    protectedPaths,
    artifactRoot: resolveArtifactRoot(),
    ...(ctx.allowCritical === undefined ? {} : { allowCritical: ctx.allowCritical }),
  });
  const prefilter = createLexicalHardBlockPrefilter({ cwd: ctx.cwd, astroHome, protectedPaths });
  const check = (abs: string): void => {
    if (!prefilter(abs)) return; // sem candidato léxico, a classe não muda
    if (classifier(abs) === "hard-block") {
      throw new ToolError(`operação recusada: caminho bloqueado (hard-block): ${relativePath(ctx.cwd, abs)}`);
    }
  };

  check(target);
  // Destino de `move_path` pode não existir ainda: só há árvore para varrer se for diretório.
  let isDirectory = false;
  try {
    isDirectory = lstatSync(target).isDirectory();
  } catch {
    return;
  }
  if (!isDirectory) return;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new ToolError(`operação recusada: não foi possível inspecionar: ${relativePath(ctx.cwd, dir)}`);
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      check(abs);
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(target);
}
