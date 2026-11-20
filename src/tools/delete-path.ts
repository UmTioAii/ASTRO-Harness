import { lstatSync, rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertNoHardBlocked, isSamePath, relativePath } from "./path-guard";
import { resolveWritableWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface DeleteInput {
  path: string;
  recursive: boolean;
}

function parseInput(input: unknown): DeleteInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { path, recursive? }");
  }
  const raw = input as { path?: unknown; recursive?: unknown };
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new ToolError('"path" deve ser uma string não vazia');
  }
  if (raw.recursive !== undefined && typeof raw.recursive !== "boolean") {
    throw new ToolError('"recursive" deve ser booleano');
  }
  return { path: raw.path, recursive: raw.recursive === true };
}

/**
 * Remove arquivo ou diretório dentro do cwd (#535). A classe `delete` mantém
 * aprovação em `ask` e em `allow-edits` (MATRIX); diretório exige
 * `recursive: true`, e o prompt marca a remoção recursiva. `.astro/`,
 * `protectedPaths` e qualquer árvore com hard-block são recusados antes da
 * remoção (ADR-0027, I-11).
 */
export const deletePathTool: Tool = {
  manifest: {
    name: "delete_path",
    description:
      "Remove um arquivo do diretório de trabalho. Remover um diretório (com todo o conteúdo) " +
      "exige recursive: true; caminhos reservados e hard-block são sempre recusados.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho a remover, relativo ao diretório de trabalho.",
        },
        recursive: {
          type: "boolean",
          description: "Remove o diretório e todo o conteúdo (default: false).",
        },
      },
      required: ["path"],
    },
    risk: "high",
    permission: "write",
    class: "delete",
    timeoutMs: 10_000,
    retryable: false,
    idempotent: false,
    sideEffects: "filesystem",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { path, recursive } = parseInput(input);
      if (isAbsolute(path)) {
        throw new ToolError(`path absoluto não é aceito: ${path}; use caminho relativo ao cwd`);
      }
      const target = resolveWritableWithin(ctx.cwd, path, ctx.protectedPaths ?? []);
      if (isSamePath(target, ctx.cwd)) {
        throw new ToolError("recusado: o diretório de trabalho não pode ser removido");
      }

      let stats;
      try {
        stats = lstatSync(target);
      } catch {
        return failure(`caminho não existe: ${path}`);
      }
      assertNoHardBlocked(target, ctx);

      if (stats.isDirectory()) {
        if (!recursive) {
          return failure(`"${path}" é um diretório; remoção de diretório exige recursive: true`);
        }
        rmSync(target, { recursive: true });
        return { output: `diretório removido (recursivo): ${relativePath(ctx.cwd, target)}` };
      }
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        return failure(`tipo de caminho não suportado para remoção: ${path}`);
      }
      rmSync(target);
      return { output: `arquivo removido: ${relativePath(ctx.cwd, target)}` };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao remover: ${message}`);
    }
  },
};
