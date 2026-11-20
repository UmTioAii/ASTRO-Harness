import { lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_OUTPUT_LIMIT } from "../output-limit";
import { resolveWithin, canonicalize, isWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

/** Teto de resultados (#534): acima disso a saída é truncada com aviso explícito. */
const MAX_RESULTS = 500;

/** Reserva do envelope JSON + `notice` no orçamento de caracteres da saída. */
const OUTPUT_RESERVE_CHARS = 256;

/** Mesmos diretórios de ruído que `grep`/`list_dir` ignoram (opt-in em `includeIgnored`). */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".astro", "dist", "coverage", ".worktrees"]);

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

/**
 * `..` que subiria acima da raiz é recusado; `a/../b` continua válido. A
 * checagem é léxica, para o erro ser claro: o percurso nunca sai da raiz (I-11).
 */
function escapesRoot(pattern: string): boolean {
  let depth = 0;
  for (const segment of pattern.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      depth++;
      continue;
    }
    if (depth === 0) return true;
    depth--;
  }
  return false;
}

/**
 * Prefixo absoluto no formato Windows (drive `C:\`/`C:x` e qualquer `\` inicial).
 * `isAbsolute` depende da plataforma: no POSIX `C:\Windows\**` viraria padrão
 * relativo literal e escaparia da recusa (CI ubuntu, #573).
 */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:|^\\/;

/**
 * Segmento com sintaxe de glob (`*`, `?`, `[]`, `{}`) não é literal; `..`
 * também não é, para nunca colapsar um `**` seguido de `..`.
 */
function isLiteralSegment(segment: string): boolean {
  return segment !== ".." && !/[*?[\]{}]/.test(segment);
}

/**
 * Normaliza o padrão antes de virar `Bun.Glob` (#573 review A): `\` vira `/`,
 * `./` inicial e `/` final somem e `literal/..` colapsa. O MESMO texto alimenta
 * o matcher e o prefixo literal: o Bun não normaliza nada disso — `./src/*.ts`
 * só casaria `./src/...`, `\` é escape mesmo no Windows e `..` fica literal.
 */
function normalizePattern(pattern: string): string {
  const segments: string[] = [];
  for (const segment of pattern.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && isLiteralSegment(segments.at(-1)!)) {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function parseInput(input: unknown): { pattern: string; path: string; includeIgnored: boolean } {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { pattern }");
  }
  const raw = input as { pattern?: unknown; path?: unknown; includeIgnored?: unknown };
  if (typeof raw.pattern !== "string" || raw.pattern.length === 0) {
    throw new ToolError('"pattern" deve ser uma string não vazia');
  }
  if (isAbsolute(raw.pattern) || WINDOWS_ABSOLUTE.test(raw.pattern)) {
    throw new ToolError(`padrão absoluto não é permitido: ${raw.pattern}`);
  }
  if (raw.pattern.startsWith("~") || escapesRoot(raw.pattern)) {
    throw new ToolError(`padrão fora do diretório de trabalho: ${raw.pattern}`);
  }
  return {
    pattern: normalizePattern(raw.pattern),
    path: typeof raw.path === "string" && raw.path.length > 0 ? raw.path : ".",
    includeIgnored: raw.includeIgnored === true,
  };
}

/** Prefixo literal do padrão normalizado (`src/tools/*.ts` → `src/tools`), para não varrer o resto da árvore. */
function literalPrefix(pattern: string): string {
  const segments = pattern.split("/").filter((segment) => segment !== "" && segment !== ".");
  const literal: string[] = [];
  for (const segment of segments) {
    if (/[*?[\]{}]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.join("/");
}

/** Caminho relativo à raiz, com separador `/` (formato do padrão e da saída). */
function relativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

/**
 * Percorre a partir de `start` os arquivos cujo caminho relativo a `root` casa
 * com o padrão. Symlink não é seguido, então nada fora da raiz entra na lista.
 */
function collect(root: string, start: string, matcher: Bun.Glob, includeIgnored: boolean): string[] {
  const files: string[] = [];
  let startStats: Stats;
  try {
    startStats = lstatSync(start);
  } catch {
    return files; // prefixo literal inexistente: nenhum resultado
  }
  // Symlink na raiz do percurso não é seguido, mesmo apontando para dentro.
  if (startStats.isSymbolicLink()) return files;
  // Padrão literal apontando para um arquivo: casa com o próprio caminho.
  if (!startStats.isDirectory()) {
    const candidate = relativePosix(root, start);
    if (startStats.isFile() && matcher.match(candidate)) files.push(candidate);
    return files;
  }

  const stack: string[] = [start];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // diretório ilegível: pula
    }
    for (const entry of entries) {
      // Symlink não é seguido: o alvo pode estar fora do cwd.
      if (entry.isSymbolicLink()) continue;
      const absPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (includeIgnored || !SKIP_DIRS.has(entry.name)) stack.push(absPath);
      } else if (
        entry.isFile() &&
        (includeIgnored || !SKIP_DIRS.has(entry.name)) &&
        matcher.match(relativePosix(root, absPath))
      ) {
        files.push(relativePosix(root, absPath));
      }
    }
  }
  return files;
}

/** Primeiro segmento excluído por padrão no caminho relativo, se houver (opt-in em `includeIgnored`). */
function skippedSegment(relativePath: string): string | undefined {
  return relativePath.split("/").find((segment) => SKIP_DIRS.has(segment));
}

/**
 * Preenche `files` respeitando o cap de resultados e o orçamento de caracteres
 * do executor (#573 review A): 500 caminhos de monorepo podem passar de 8000
 * tokens e o `limitToolOutput` trocaria o JSON por head/tail, quebrando o
 * contrato. O mesmo orçamento cobre o envelope e o `notice`.
 */
function fitResults(matches: readonly string[], capTokens: number): { files: string[]; truncated: boolean } {
  const budgetChars = Math.max(64, capTokens * 4 - OUTPUT_RESERVE_CHARS);
  const files: string[] = [];
  let used = 0;
  for (const file of matches.slice(0, MAX_RESULTS)) {
    const cost = file.length + 3; // aspas + vírgula no array JSON
    if (files.length > 0 && used + cost > budgetChars) break;
    used += cost;
    files.push(file);
  }
  return { files, truncated: files.length < matches.length };
}

/** Busca arquivos por padrão glob dentro do cwd, com caminhos relativos e cap de 500. */
export const globTool: Tool = {
  manifest: {
    name: "glob",
    description:
      "Busca arquivos por padrão glob (ex.: \"src/**/*.ts\") dentro do diretório de trabalho; devolve caminhos relativos ordenados, no máximo 500.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Padrão glob relativo ao cwd (ex.: \"src/**/*.ts\"). Padrão absoluto ou com `..` para fora do cwd é recusado.",
        },
        path: {
          type: "string",
          description: "Subdiretório relativo ao cwd onde buscar (default: \".\").",
        },
        includeIgnored: {
          type: "boolean",
          description: "Inclui .git, node_modules, .astro, dist, coverage e .worktrees (default: false).",
        },
      },
      required: ["pattern"],
    },
    risk: "low",
    permission: "read",
    class: "read_common",
    // Como no `grep`, o walk é síncrono: este teto declara o custo máximo da
    // chamada (o executor não consegue preemptar `readdirSync`).
    timeoutMs: 10_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { pattern, path, includeIgnored } = parseInput(input);
      const root = resolveWithin(ctx.cwd, path);
      let stats: Stats;
      try {
        stats = statSync(root);
      } catch {
        return failure(`caminho não existe: ${path}`);
      }
      if (!stats.isDirectory()) return failure(`caminho não é um diretório: ${path}`);

      const matcher = new Bun.Glob(pattern);
      const prefix = literalPrefix(pattern);
      const start = prefix.length === 0 ? root : resolve(root, prefix);
      // Exclusão por default vale para `path` e para o prefixo do padrão: o
      // `includeIgnored` é o único opt-in (não há exceção silenciosa).
      if (!includeIgnored) {
        const skipped = skippedSegment(relativePosix(ctx.cwd, root)) ?? skippedSegment(relativePosix(root, start));
        if (skipped !== undefined) {
          return failure(`diretório excluído por padrão: ${skipped}; use includeIgnored: true`);
        }
      }
      // Um prefixo literal pode atravessar um link para fora do cwd
      // (`escape/fora.ts`); o realpath do início precisa continuar dentro da raiz.
      if (!isWithin(canonicalize(root), canonicalize(start))) {
        return failure(`caminho fora do diretório de trabalho: ${pattern}`);
      }

      const matches = collect(root, start, matcher, includeIgnored)
        // Caminhos relativos ao cwd: o modelo usa direto em read_file.
        .map((file) => relativePosix(ctx.cwd, join(root, file)))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const total = matches.length;
      const { files, truncated } = fitResults(matches, ctx.outputLimitTokens ?? DEFAULT_OUTPUT_LIMIT.maxTokens);
      const notice = truncated
        ? `resultado truncado: exibindo ${files.length} de ${total} arquivos; refine o padrão ou use "path" para ver o resto`
        : undefined;

      return { output: JSON.stringify({ files, total, truncated, ...(notice === undefined ? {} : { notice }) }) };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no glob: ${message}`);
    }
  },
};
