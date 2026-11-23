import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { redactSecrets } from "../sanitize-external";
import { contentBudgetChars, failureResult, truncationReport } from "./contract";
import { resolveWithin } from "./paths";
import { type Tool, type ToolResult } from "./types";

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 10;
/** Conservative JSON cost per entry: `{"name":"","type":"file"},`. */
const ENTRY_OVERHEAD = 32;

interface ListDirInput {
  path: string;
  depth: number;
}

interface DirNode {
  name: string;
  type: "file" | "dir";
  children?: DirNode[];
}

/** Shared walk budget (S6, #603): what fits the declared ceiling and what did not. */
interface Budget {
  cap: number;
  chars: number;
  kept: number;
  omitted: number;
  truncated: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".astro", "dist", "coverage", ".worktrees"]);

/** Fixed denial text: never echoes the input or an absolute path from a fs error. */
const OUTSIDE_MESSAGE = "path outside the working directory";

function parseInput(input: unknown): ListDirInput {
  const raw = (typeof input === "object" && input !== null ? input : {}) as { path?: unknown; depth?: unknown };
  const path = typeof raw.path === "string" && raw.path.length > 0 ? raw.path : ".";
  let depth = typeof raw.depth === "number" && Number.isFinite(raw.depth) ? raw.depth : DEFAULT_DEPTH;
  if (depth < 1) depth = 1;
  if (depth > MAX_DEPTH) depth = MAX_DEPTH;
  return { path, depth };
}

/** Accounts one entry; false once the budget is exhausted (later entries count as omitted). */
function take(name: string, budget: Budget): boolean {
  const cost = name.length + ENTRY_OVERHEAD;
  if (budget.truncated || budget.chars + cost > budget.cap) {
    budget.truncated = true;
    budget.omitted++;
    return false;
  }
  budget.chars += cost;
  budget.kept++;
  return true;
}

/** Counts a skipped directory's subtree, same depth limit, so `removed` is not one entry. */
function countHidden(dir: string, depth: number, budget: Budget): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      budget.omitted++;
      if (depth > 1) countHidden(join(dir, entry.name), depth - 1, budget);
    } else if (entry.isFile()) {
      budget.omitted++;
    }
  }
}

/** Constrói a árvore de diretórios a partir de `dir`, até `depth` níveis. */
function buildTree(dir: string, name: string, depth: number, budget: Budget): DirNode {
  const children: DirNode[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { name, type: "dir" };
  }
  // Deterministic order before the cut: same entries inside the ceiling on every OS.
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.isDirectory() ? -1 : 1);

  for (const entry of entries) {
    // I-03: redact at the source, before any cut can leave a partial value.
    const entryName = redactSecrets(entry.name);
    // Não segue symlink nem diretórios ignorados
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (!take(entryName, budget)) {
        if (depth > 1) countHidden(join(dir, entry.name), depth - 1, budget);
        continue;
      }
      if (depth > 1) {
        children.push(buildTree(join(dir, entry.name), entryName, depth - 1, budget));
      } else {
        children.push({ name: entryName, type: "dir" });
      }
    } else if (entry.isFile()) {
      if (!take(entryName, budget)) continue;
      children.push({ name: entryName, type: "file" });
    }
    // symlinks e outros tipos são omitidos
  }

  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { name, type: "dir", children };
}

/** Lista a árvore de diretórios com profundidade configurável, confinada ao cwd. */
export const listDirTool: Tool = {
  manifest: {
    name: "list_dir",
    description: "Lista a árvore de diretórios a partir de um caminho, com profundidade configurável.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho relativo ao cwd (default: \".\").",
        },
        depth: {
          type: "number",
          description: "Profundidade máxima da árvore (default: 3, máximo: 10).",
        },
      },
      required: [],
    },
    risk: "low",
    permission: "read",
    class: "read_common",
    timeoutMs: 10_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
    output: { maxTokens: 4000, hint: "list a subdirectory or lower depth to see the rest" },
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { path, depth } = parseInput(input);
      let root: string;
      try {
        root = resolveWithin(ctx.cwd, path);
      } catch {
        // I-11 + I-03: a fixed denial, never the input or an absolute fs path.
        return failureResult(OUTSIDE_MESSAGE, "denied");
      }

      // Caminho precisa existir e ser diretório
      let stats;
      try {
        stats = statSync(root);
      } catch {
        return failureResult(`caminho não existe: ${path}`, "failed");
      }
      if (!stats.isDirectory()) {
        return failureResult(`caminho não é um diretório: ${path}`, "failed");
      }

      const ceiling = listDirTool.manifest.output!;
      const budget: Budget = { cap: contentBudgetChars(ceiling, ctx), chars: 0, kept: 0, omitted: 0, truncated: false };
      const tree = buildTree(root, redactSecrets(basename(root)), depth, budget);
      if (!budget.truncated) return { output: JSON.stringify(tree) };

      const { field, marker } = truncationReport({
        removed: budget.omitted,
        total: budget.kept + budget.omitted,
        unit: "entries",
        hint: ceiling.hint,
      });
      return { output: JSON.stringify({ ...tree, truncated: true, notice: marker }), truncation: field };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failureResult(`erro ao listar diretório: ${message}`, "failed");
    }
  },
};
