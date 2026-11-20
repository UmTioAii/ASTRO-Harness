import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { assertNoHardBlocked, isSamePath, relativePath } from "./path-guard";
import { canonicalize, isWithin, resolveWritableWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

interface MoveInput {
  from: string;
  to: string;
  overwrite: boolean;
}

function parseInput(input: unknown): MoveInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { from, to, overwrite? }");
  }
  const raw = input as { from?: unknown; to?: unknown; overwrite?: unknown };
  if (typeof raw.from !== "string" || raw.from.length === 0) {
    throw new ToolError('"from" deve ser uma string não vazia');
  }
  if (typeof raw.to !== "string" || raw.to.length === 0) {
    throw new ToolError('"to" deve ser uma string não vazia');
  }
  if (raw.overwrite !== undefined && typeof raw.overwrite !== "boolean") {
    throw new ToolError('"overwrite" deve ser booleano');
  }
  return { from: raw.from, to: raw.to, overwrite: raw.overwrite === true };
}

/**
 * Move/renomeia arquivo ou diretório dentro do cwd (#535). Origem e destino
 * passam por `resolveWritableWithin` (I-11 + `.astro/`/`protectedPaths`);
 * `overwrite` só substitui arquivo, nunca árvore, e o destino não pode cair
 * dentro da própria origem. Sem symlink seguido para fora do cwd.
 */
export const movePathTool: Tool = {
  manifest: {
    name: "move_path",
    description:
      "Move ou renomeia um arquivo/diretório dentro do diretório de trabalho, criando os diretórios " +
      "de destino. Um destino existente só é substituído com overwrite: true (arquivo).",
    parameters: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Caminho de origem, relativo ao diretório de trabalho.",
        },
        to: {
          type: "string",
          description: "Caminho de destino, relativo ao diretório de trabalho.",
        },
        overwrite: {
          type: "boolean",
          description: "Substitui um arquivo de destino existente (default: false).",
        },
      },
      required: ["from", "to"],
    },
    risk: "medium",
    permission: "write",
    class: "edit",
    timeoutMs: 10_000,
    retryable: false,
    idempotent: false,
    sideEffects: "filesystem",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const { from, to, overwrite } = parseInput(input);
      for (const [field, value] of [["from", from], ["to", to]] as const) {
        if (isAbsolute(value)) {
          throw new ToolError(`${field} absoluto não é aceito: ${value}; use caminho relativo ao cwd`);
        }
      }
      const protectedPaths = ctx.protectedPaths ?? [];
      const source = resolveWritableWithin(ctx.cwd, from, protectedPaths);
      const destination = resolveWritableWithin(ctx.cwd, to, protectedPaths);
      if (isSamePath(source, ctx.cwd)) {
        throw new ToolError("recusado: o diretório de trabalho não pode ser movido");
      }

      let sourceDir: boolean;
      try {
        sourceDir = lstatSync(source).isDirectory();
      } catch {
        return failure(`origem não existe: ${from}`);
      }

      const realSource = canonicalize(source);
      const realDestination = canonicalize(destination);
      if (isSamePath(realSource, realDestination)) {
        return failure(`nenhuma mudança: origem e destino são o mesmo caminho: ${from}`);
      }
      if (sourceDir && isWithin(realSource, realDestination)) {
        return failure(`recusado: destino dentro da própria origem: ${to}`);
      }

      // Nada é tocado antes do piso de hard-block (origem, destino e árvore).
      assertNoHardBlocked(source, ctx);
      assertNoHardBlocked(destination, ctx);

      let destinationExists = false;
      let destinationDir = false;
      try {
        const stats = lstatSync(destination);
        destinationExists = true;
        destinationDir = stats.isDirectory();
      } catch {
        destinationExists = false;
      }
      if (destinationExists) {
        if (!overwrite) {
          return failure(`destino já existe: ${to} (use overwrite: true para substituir um arquivo)`);
        }
        if (destinationDir) {
          return failure(`destino é um diretório; overwrite só substitui arquivo: ${to}`);
        }
        rmSync(destination);
      }

      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      return {
        output: `movido: ${relativePath(ctx.cwd, source)} -> ${relativePath(ctx.cwd, destination)}`,
      };
    } catch (error) {
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao mover: ${message}`);
    }
  },
};
