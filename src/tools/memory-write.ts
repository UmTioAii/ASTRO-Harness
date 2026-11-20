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
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MEMORY_SCOPES,
  hasTopLevelHeading,
  resolveMemoryPaths,
  topLevelHeadingIndexes,
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
  // `## ` de nível 2 no texto criaria uma seção nova e quebraria o contrato de
  // "uma seção por chamada"; dentro de fence é conteúdo legítimo.
  if (hasTopLevelHeading(text)) {
    throw new ToolError('entrada inválida: "text" não pode conter heading de nível 2 ("## ") fora de code fence');
  }
  return { scope: input.scope as MemoryScope, section, text };
}

/**
 * Substitui o corpo de `## section` ou acrescenta a seção no fim. Os headings
 * são localizados pelo splitter fence-aware: `## ` dentro de ``` nunca encerra
 * a seção. Se o arquivo tiver seções duplicadas com o mesmo título, todas são
 * fundidas na primeira posição (uma chamada = uma seção no arquivo).
 *
 * As seções não tocadas são copiadas byte a byte - nada de re-serializar ou
 * redigir o que já está em disco.
 */
export function applyMemorySection(existing: string, section: string, text: string): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split("\n");
  const headings = topLevelHeadingIndexes(lines);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const heading = `## ${section}`;
  const matches = headings.filter((index) => lines[index]!.trimEnd() === heading);
  const replacement = `## ${section}${newline}${newline}${text}`;

  if (matches.length === 0) {
    const base = existing.replace(/\s+$/, "");
    return base.length === 0
      ? `${replacement}${newline}`
      : `${base}${newline}${newline}${replacement}${newline}`;
  }

  const endOf = (index: number): number => {
    const next = headings.find((candidate) => candidate > index);
    return next === undefined ? existing.length : starts[next]!;
  };
  let output = "";
  let cursor = 0;
  matches.forEach((index, order) => {
    const start = starts[index]!;
    const end = endOf(index);
    output += existing.slice(cursor, start);
    if (order === 0) output += replacement + (end === existing.length ? newline : newline + newline);
    cursor = end;
  });
  output += existing.slice(cursor);
  return output.replace(/(?:\r?\n)+$/, "") + newline;
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
        // Lê o arquivo como está: seções intocadas não passam por redação de
        // novo (o que já está em disco foi decidido quando foi escrito).
        const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
        const content = applyMemorySection(existing, parsed.section, text);
        const delta = content.length - existing.length;
        const targetDir = dirname(target);
        // Home global com 0700, como o cofre; o `.astro` do projeto já é do cwd.
        if (parsed.scope === "global") {
          mkdirSync(targetDir, { recursive: true, mode: 0o700 });
          if (process.platform !== "win32") {
            try { chmodSync(targetDir, 0o700); } catch { /* melhor esforço */ }
          }
        } else {
          mkdirSync(targetDir, { recursive: true });
        }
        // I-16: backup antes de trocar, mesmo formato do `edit`.
        if (existing.length > 0) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          copyFileSync(target, `${target}.${stamp}.bak`);
        }
        // Troca atômica: tmp no mesmo diretório + rename.
        const tmp = `${target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
          renameSync(tmp, target);
        } catch (error) {
          try { unlinkSync(tmp); } catch { /* tmp já não existe */ }
          throw error;
        }
        // Só contagem e identificação da seção: o texto nunca vai ao audit (I-03).
        deps.audit.append({
          run: ctx.run,
          agent: ctx.agent,
          tipo: "memory.write",
          payload: { scope: parsed.scope, section: parsed.section, chars },
        });
        return {
          output:
            `memória escrita: ${parsed.scope} "${parsed.section}" ` +
            `(${chars} caracteres, delta ${delta >= 0 ? "+" : ""}${delta}) em ${target}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: `memory_write: falha ao gravar: ${redactSecrets(message)}`, isError: true };
      }
    },
  };
}
