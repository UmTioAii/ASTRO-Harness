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
}

interface Guards {
  /** Nó isolado: **sempre** classificado (o prefilter léxico não vê ADS). */
  node: (abs: string) => void;
  /** Descendente: o prefilter barato só decide se vale pagar a classificação. */
  descendant: (abs: string) => void;
}

/**
 * Classificadores do piso de hard-block (#535). `allowCritical` não entra: o
 * flag autoriza leitura/escrita pontual, nunca remoção/renomeação de caminho
 * crítico.
 */
function guardsFor(ctx: PathGuardContext): Guards {
  const astroHome = resolveAstroHome();
  const protectedPaths = ctx.protectedPaths ?? [];
  const classifier = createPathClassifier({
    cwd: ctx.cwd,
    astroHome,
    protectedPaths,
    artifactRoot: resolveArtifactRoot(),
  });
  const prefilter = createLexicalHardBlockPrefilter({ cwd: ctx.cwd, astroHome, protectedPaths });
  const node = (abs: string): void => {
    if (classifier(abs) === "hard-block") {
      throw new ToolError(`operação recusada: caminho bloqueado (hard-block): ${relativePath(ctx.cwd, abs)}`);
    }
  };
  return {
    node,
    // O prefilter é léxico: não conhece a forma ADS do NTFS (`.env::$DATA`), que
    // o `stripAds` do classifier reduz a `.env`. Por isso a raiz usa `node`.
    descendant: (abs) => {
      if (prefilter(abs)) node(abs);
    },
  };
}

/** Recusa o nó se for hard-block; não varre descendentes (destino de `move_path`). */
export function assertPathNotHardBlocked(target: string, ctx: PathGuardContext): void {
  guardsFor(ctx).node(target);
}

/**
 * Piso fixo das tools destrutivas (#535): o alvo — e, quando é diretório, todo
 * descendente — não pode cair em `hard-block` (ADR-0027), matando
 * `delete_path({ path: "projeto", recursive: true })` e
 * `move_path({ from: "projeto" })` sobre uma árvore com `.env`/`.git`/
 * `protectedPaths`. Roda antes de qualquer mutação, então a recusa deixa a
 * árvore intacta. Symlink não é seguido: `Dirent.isDirectory()` é falso para
 * link, e o walk nunca sai do cwd (I-11).
 */
export function assertNoHardBlocked(target: string, ctx: PathGuardContext): void {
  const guards = guardsFor(ctx);
  guards.node(target);
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
      guards.descendant(abs);
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(target);
}

/** Código errno do erro de FS, ou "" quando não há. */
export function fsErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

/**
 * Mensagem de erro de FS sem o texto cru do SO (#535): só código conhecido
 * mapeado + caminho relativo (`target`). `EEXIST`/`ENOTDIR` = path atravessa um
 * arquivo; `ENOENT` = sumiu no meio; `EXDEV`/`EACCES`/`EPERM`/`EBUSY` = mensagem
 * fixa; demais = só o código, nunca `error.message` (que traz path absoluto).
 */
export function fsFailure(action: "mover" | "remover", error: unknown, target: string): string {
  const path = target === "" ? "caminho" : target;
  switch (fsErrorCode(error)) {
    case "EEXIST":
    case "ENOTDIR":
      return action === "mover"
        ? `o destino atravessa um arquivo: ${path}`
        : `o caminho atravessa um arquivo: ${path}`;
    case "ENOENT":
      return `caminho não existe: ${path}`;
    case "EXDEV":
      return "operação não atravessa sistemas de arquivos diferentes (EXDEV)";
    case "EACCES":
    case "EPERM":
    case "EBUSY":
      return `permissão negada pelo sistema de arquivos: ${path}`;
    default: {
      const code = fsErrorCode(error);
      return code === "" ? `erro ao ${action}` : `erro ao ${action}: ${code}`;
    }
  }
}
