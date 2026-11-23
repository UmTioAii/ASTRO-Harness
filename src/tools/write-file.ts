import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { failureResult } from "./contract";
import { resolveWritableWithin } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

function writeInput(input: unknown): { path: string; content: string } {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { path, content }");
  }
  const { path, content } = input as { path?: unknown; content?: unknown };
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolError("entrada inválida: \"path\" deve ser uma string não vazia");
  }
  if (typeof content !== "string") {
    throw new ToolError("entrada inválida: \"content\" deve ser uma string");
  }
  return { path, content };
}

/** Escreve um arquivo de texto confinado ao diretório de trabalho. */
export const writeFileTool: Tool = {
  manifest: {
    name: "write_file",
    description: "Escreve um arquivo de texto no diretório de trabalho, criando diretórios se preciso.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Caminho do arquivo, relativo ao diretório de trabalho.",
        },
        content: {
          type: "string",
          description: "Conteúdo completo a escrever no arquivo.",
        },
      },
      required: ["path", "content"],
    },
    risk: "medium",
    permission: "write",
    class: "edit",
    timeoutMs: 5_000,
    retryable: false,
    idempotent: true,
    sideEffects: "filesystem",
  },

  async execute(input, ctx): Promise<ToolResult> {
    let path: string;
    let content: string;
    try {
      ({ path, content } = writeInput(input));
    } catch (error) {
      return failureResult(error instanceof Error ? error.message : String(error), "invalid");
    }
    let target: string;
    try {
      target = resolveWritableWithin(ctx.cwd, path, ctx.protectedPaths ?? []);
    } catch (error) {
      // I-11: a confinement or reserved-path refusal is a denial, not a failure.
      return failureResult(error instanceof Error ? error.message : String(error), "denied");
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      return { output: `arquivo escrito: ${path}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failureResult(`erro ao escrever arquivo: ${message}`, "failed");
    }
  },
};
