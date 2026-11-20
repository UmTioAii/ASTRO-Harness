/**
 * Tool `memory_write` (#532): única porta de escrita da memória persistida.
 *
 * A memória entra no system prompt no início de cada run; por isso a escrita é
 * uma ação explícita e aprovada (`class: "edit"`), nunca aprendida de
 * transcript. O alvo é derivado do `scope` - `memory_write` não aceita path -,
 * e ainda assim passa pelo confinamento (I-11): symlink/junction que sai do
 * cwd ou de `$ASTRO_HOME` é recusado, e `protectedPaths` continuam proibidos.
 * O texto é redigido antes de tocar o disco (I-03) e a auditoria leva só
 * `{ scope, section, chars }`, nunca conteúdo.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MEMORY_SCOPES,
  resolveMemoryPaths,
  type MemoryAudit,
  type MemoryScope,
} from "../memory";
import { redactSecrets } from "../sanitize-external";
import { assertConfinedPath } from "./paths";
import type { Tool, ToolContext, ToolResult } from "./types";
import { ToolError } from "./types";

/** Código estável de entrada inválida (D-18: erro classificado). */
export const MEMORY_INVALID_INPUT = "invalid_input";
/** Código estável do confinamento recusado (I-11). */
export const MEMORY_PATH_DENIED = "path_denied";

/** Teto de uma escrita: acima disso não é memória, é despejo de arquivo. */
export const MAX_MEMORY_TEXT_CHARS = 4000;
/** Teto do nome da seção, contado em code points. */
export const MAX_MEMORY_SECTION_CHARS = 60;
/** Nome de seção aceito: uma linha, sem `#`/quebra, com letras/números. */
const SECTION_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u;

export interface MemoryWriteDeps {
  audit: MemoryAudit;
  /** Ambiente do run; decide `$ASTRO_HOME` do escopo global. */
  env?: Record<string, string | undefined>;
}

interface MemoryWriteInput {
  scope: MemoryScope;
  section: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Valida o input inteiro antes de qualquer efeito; mensagens nunca ecoam texto. */
function parseInput(input: unknown): MemoryWriteInput {
  if (!isRecord(input)) {
    throw new ToolError('entrada inválida: esperado objeto { scope, section, text }');
  }
  const unknownField = Object.keys(input).find((key) => !["scope", "section", "text"].includes(key));
  if (unknownField !== undefined) {
    throw new ToolError(`entrada inválida: campo desconhecido "${unknownField}" (permitidos: scope, section, text)`);
  }
  if (typeof input.scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(input.scope)) {
    throw new ToolError('entrada inválida: "scope" deve ser "global" ou "project"');
  }
  if (typeof input.section !== "string") {
    throw new ToolError('entrada inválida: "section" deve ser uma string');
  }
  const section = input.section.trim();
  if (section.length === 0 || section.length > MAX_MEMORY_SECTION_CHARS || !SECTION_PATTERN.test(section)) {
    throw new ToolError(
      `entrada inválida: "section" deve ter até ${MAX_MEMORY_SECTION_CHARS} caracteres em uma linha ` +
        "(letras, números, espaço, '.', '-' ou '_')",
    );
  }
  if (typeof input.text !== "string") {
    throw new ToolError('entrada inválida: "text" deve ser uma string');
  }
  const text = input.text.trim();
  if (text.length === 0) {
    throw new ToolError('entrada inválida: "text" não pode ser vazio');
  }
  if (Array.from(text).length > MAX_MEMORY_TEXT_CHARS) {
    throw new ToolError(`entrada inválida: "text" excede ${MAX_MEMORY_TEXT_CHARS} caracteres`);
  }
  return { scope: input.scope as MemoryScope, section, text };
}

/**
 * Substitui o corpo de `## section` ou acrescenta a seção no fim. Um `## ` de
 * qualquer seção encerra o corpo; outro nível de heading (`###`) continua
 * dentro dela. O arquivo existente é redigido de novo antes de reescrever
 * (nada de segredo antigo voltar) - leitura e escrita são do mesmo alvo.
 */
export function applyMemorySection(existing: string, section: string, text: string): string {
  const heading = `## ${section}`;
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  const body = `## ${section}\n\n${text}`;
  if (start < 0) {
    const trimmed = existing.replace(/\s+$/, "");
    return trimmed.length === 0 ? `${body}\n` : `${trimmed}\n\n${body}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n").replace(/\s+$/, "");
  return [before, body, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .concat("\n");
}

/** Cria a tool; o audit e o env vêm do run (mesmo `Auditor` das outras tools). */
export function createMemoryWriteTool(deps: MemoryWriteDeps): Tool {
  return {
    manifest: {
      name: "memory_write",
      description:
        "Acrescenta ou substitui uma seção '## <section>' na memória persistida. " +
        "scope 'project' escreve em <cwd>/.astro/memory.md; scope 'global' em $ASTRO_HOME/memory.md. " +
        "O texto é redigido antes de gravar; a mudança só vale no próximo run.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: [...MEMORY_SCOPES],
            description: "project (esta pasta) ou global (todas as pastas).",
          },
          section: {
            type: "string",
            description: `Nome da seção, uma linha, até ${MAX_MEMORY_SECTION_CHARS} caracteres.`,
          },
          text: {
            type: "string",
            description: `Conteúdo markdown da seção, até ${MAX_MEMORY_TEXT_CHARS} caracteres.`,
          },
        },
        required: ["scope", "section", "text"],
        additionalProperties: false,
      },
      risk: "medium",
      permission: "write",
      class: "edit",
      timeoutMs: 5_000,
      retryable: false,
      idempotent: true,
      sideEffects: "filesystem",
    },

    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      let parsed: MemoryWriteInput;
      try {
        parsed = parseInput(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `memory_write: ${redactSecrets(message)}`, isError: true, code: MEMORY_INVALID_INPUT };
      }

      const env = deps.env ?? ctx.env ?? process.env;
      const paths = resolveMemoryPaths(ctx.cwd, env);
      const target = parsed.scope === "global" ? paths.global : paths.project;
      const root = parsed.scope === "global" ? dirname(target) : ctx.cwd;

      try {
        assertConfinedPath(root, target, ctx.protectedPaths ?? []);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `memory_write: ${redactSecrets(message)}`, isError: true, code: MEMORY_PATH_DENIED };
      }

      const text = redactSecrets(parsed.text);
      const chars = Array.from(text).length;
      try {
        let existing = "";
        try {
          existing = redactSecrets(readFileSync(target, "utf8"));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }
        const content = applyMemorySection(existing, parsed.section, text);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
        // Só contagem e identificação da seção: o texto nunca vai ao audit (I-03).
        deps.audit.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "memory.write",
          payload: { scope: parsed.scope, section: parsed.section, chars },
        });
        return {
          output: `memória escrita: ${parsed.scope} "${parsed.section}" (${chars} caracteres) em ${target}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `memory_write: falha ao gravar: ${redactSecrets(message)}`, isError: true };
      }
    },
  };
}
