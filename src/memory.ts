/**
 * Memória do projeto (#532): markdown como fonte da verdade, injetado no
 * system prompt no início do run. Dois arquivos, global primeiro:
 *
 * - `$ASTRO_HOME/memory.md`  (global, vale para toda pasta)
 * - `<cwd>/.astro/memory.md` (project, nunca cruza para outra pasta)
 *
 * O conteúdo é tratado como dado, não como instrução executável: passa por
 * `redactSecrets` antes de entrar no prompt (I-03) e é limitado por
 * `memory.maxChars`, com corte na fronteira de seção - o modelo nunca recebe
 * meia seção. Nada é escrito aqui: a escrita só existe via `memory_write`.
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAstroHome } from "./permissions";
import { redactSecrets } from "./sanitize-external";
import { assertConfinedPath } from "./tools/paths";

/** Teto default de caracteres injetados (`memory.maxChars`). */
export const DEFAULT_MEMORY_MAX_CHARS = 8000;

/** Nome do arquivo de memória nas duas raízes. */
export const MEMORY_FILE_NAME = "memory.md";

/** Título da seção no system prompt. */
export const MEMORY_HEADING = "## Memory";

export type MemoryScope = "global" | "project";

/** Escopos aceitos por `memory_write`; vocabulário fechado. */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["global", "project"];

/** Linha fixa do bloco: diz ao modelo que só `memory_write` altera a memória. */
const MEMORY_HINT = "Memória persistida entre runs. Escreva só com memory_write({ scope, section, text }).";

export interface MemoryPaths {
  global: string;
  project: string;
}

/** Bloco injetado de um arquivo; `text` já redigido. */
export interface MemoryBlock {
  scope: MemoryScope;
  path: string;
  text: string;
  /** `true` quando algum bloco do mesmo arquivo ficou de fora. */
  truncated: boolean;
}

export interface MemorySnapshot {
  paths: MemoryPaths;
  maxChars: number;
  /** Blocos efetivamente injetados (arquivo ausente ou vazio não entra). */
  blocks: MemoryBlock[];
  truncated: boolean;
  /** Caracteres do prompt de memória; 0 quando não há nada a injetar. */
  usedChars: number;
  remainingChars: number;
  /** Seção pronta para o system prompt; `undefined` sem memória. */
  prompt?: string;
  warnings: string[];
}

/** Auditor mínimo aceito pelo loader (evita import cíclico com `src/audit`). */
export interface MemoryAudit {
  append(event: { run: string; agent?: string; tipo: string; payload?: Record<string, unknown> }): unknown;
}

export interface LoadMemoryOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  maxChars?: number;
  warn?: (message: string) => void;
  audit?: MemoryAudit;
  run?: string;
  agent?: string;
}

/** Caminhos canônicos dos dois arquivos, sem tocar o disco. */
export function resolveMemoryPaths(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): MemoryPaths {
  return {
    global: join(resolve(resolveAstroHome(env)), MEMORY_FILE_NAME),
    project: join(resolve(cwd), ".astro", MEMORY_FILE_NAME),
  };
}

/** Marcador de corte, sempre visível: o modelo sabe que falta conteúdo. */
export function memoryTruncationMarker(omittedBytes: number): string {
  return `[... memória truncada: ${omittedBytes} bytes omitidos ...]`;
}

/**
 * Divide o texto em blocos de seção: o preâmbulo (antes do primeiro `## `) e
 * cada `## título` até o próximo heading de mesmo nível. O bloco inteiro entra
 * ou fica de fora - nunca um pedaço.
 */
function sectionChunks(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line) && current.some((entry) => entry.trim() !== "")) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  chunks.push(current.join("\n"));
  return chunks
    .map((chunk) => chunk.replace(/\s+$/, ""))
    .filter((chunk) => chunk.trim().length > 0);
}

interface Chunk {
  scope: MemoryScope;
  path: string;
  text: string;
}

/**
 * Lê e redige um arquivo de memória. `undefined` = ausente (normal).
 * Arquivo ilegível, link que escapa da raiz ou path reservado viram aviso e o
 * run segue sem aquele bloco.
 */
function readMemoryFile(
  scope: MemoryScope,
  path: string,
  root: string,
  protectedPaths: readonly string[],
  warn: (message: string) => void,
): Chunk[] | undefined {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    warn(`memória: não foi possível ler ${path} (${code ?? "erro"}); seguindo sem ela`);
    return undefined;
  }
  if (!stat.isFile()) {
    warn(`memória: ${path} não é um arquivo; seguindo sem ela`);
    return undefined;
  }
  try {
    assertConfinedPath(root, path, protectedPaths);
  } catch {
    warn(`memória: ${path} fora da raiz permitida (link?); seguindo sem ela`);
    return undefined;
  }
  try {
    const text = redactSecrets(readFileSync(path, "utf8"));
    return sectionChunks(text).map((chunk) => ({ scope, path, text: chunk }));
  } catch {
    warn(`memória: não foi possível ler ${path}; seguindo sem ela`);
    return undefined;
  }
}

function labelOf(scope: MemoryScope): string {
  return scope === "global" ? "Global" : "Project";
}

/** Agrupa chunks consecutivos do mesmo arquivo num bloco com um heading só. */
function groupChunks(chunks: readonly Chunk[], truncatedPaths: ReadonlySet<string>): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  for (const chunk of chunks) {
    const last = blocks.at(-1);
    if (last !== undefined && last.path === chunk.path) {
      last.text = `${last.text}\n\n${chunk.text}`;
      continue;
    }
    blocks.push({ scope: chunk.scope, path: chunk.path, text: chunk.text, truncated: truncatedPaths.has(chunk.path) });
  }
  return blocks;
}

function compose(blocks: readonly MemoryBlock[], marker?: string): string {
  const parts = [MEMORY_HEADING, "", MEMORY_HINT];
  for (const block of blocks) {
    parts.push("", `### ${labelOf(block.scope)} (${block.path})`, "", block.text);
  }
  if (marker !== undefined) parts.push("", marker);
  return parts.join("\n");
}

function bytesOf(chunks: readonly Chunk[]): number {
  return chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
}

interface Fit {
  blocks: MemoryBlock[];
  omitted: Chunk[];
  prompt: string;
}

/**
 * Maior prefixo de seções inteiras que cabe em `maxChars`, contando cabeçalho
 * fixo, heading de cada bloco e o marcador de corte. O marcador entra no
 * orçamento; por isso o corte é recalculado com o tamanho do próximo omitido.
 */
function fitChunks(chunks: readonly Chunk[], maxChars: number): Fit {
  for (let count = chunks.length; count >= 0; count--) {
    const kept = chunks.slice(0, count);
    const omitted = chunks.slice(count);
    const marker = omitted.length === 0 ? undefined : memoryTruncationMarker(bytesOf(omitted));
    const truncatedPaths = new Set(omitted.map((chunk) => chunk.path));
    const prompt = compose(groupChunks(kept, truncatedPaths), marker);
    if (prompt.length <= maxChars) return { blocks: groupChunks(kept, truncatedPaths), omitted, prompt };
  }
  // Nem o cabeçalho cabe no teto: só o marcador, cortado - nenhuma seção pela metade.
  const marker = memoryTruncationMarker(bytesOf(chunks));
  return { blocks: [], omitted: [...chunks], prompt: marker.slice(0, maxChars) };
}

/**
 * Carrega e monta a memória do run. O budget é compartilhado pelos dois
 * arquivos na ordem global -> project: o primeiro bloco que não cabe encerra a
 * coleta e o restante é omitido, auditado como `memory.truncated` por bytes.
 */
export function loadMemory(opts: LoadMemoryOptions): MemorySnapshot {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.warn?.(message);
  };
  const env = opts.env ?? process.env;
  const paths = resolveMemoryPaths(opts.cwd, env);
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MEMORY_MAX_CHARS));
  const chunks = [
    ...(readMemoryFile("global", paths.global, resolve(resolveAstroHome(env)), [], warn) ?? []),
    ...(readMemoryFile("project", paths.project, resolve(opts.cwd), [], warn) ?? []),
  ];

  if (chunks.length === 0) {
    return { paths, maxChars, blocks: [], truncated: false, usedChars: 0, remainingChars: maxChars, warnings };
  }

  const fit = fitChunks(chunks, maxChars);
  if (fit.omitted.length > 0) {
    const omittedBytes = bytesOf(fit.omitted);
    if (opts.audit !== undefined && opts.run !== undefined) {
      opts.audit.append({
        run: opts.run,
        agent: opts.agent ?? "default",
        tipo: "memory.truncated",
        payload: { scope: fit.omitted[0]!.scope, bytes: omittedBytes, maxChars },
      });
    }
  }

  return {
    paths,
    maxChars,
    blocks: fit.blocks,
    truncated: fit.omitted.length > 0,
    usedChars: fit.prompt.length,
    remainingChars: Math.max(0, maxChars - fit.prompt.length),
    prompt: fit.prompt,
    warnings,
  };
}

/** Prompt pronto para concatenação no system prompt; ausente sem memória. */
export function memoryPrompt(snapshot: MemorySnapshot): string | undefined {
  return snapshot.prompt;
}

/**
 * Texto de `/memory`: blocos injetados, caminhos e orçamento restante.
 * `pathsOnly` devolve só os dois caminhos.
 */
export function memoryReport(snapshot: MemorySnapshot, opts: { pathsOnly?: boolean } = {}): string {
  const pathLines = [
    `global: ${snapshot.paths.global}`,
    `project: ${snapshot.paths.project}`,
  ];
  if (opts.pathsOnly === true) return pathLines.join("\n");
  const header = `memória: ${snapshot.usedChars}/${snapshot.maxChars} caracteres (restante ${snapshot.remainingChars})`;
  const body = snapshot.prompt === undefined
    ? ["(nenhum bloco: arquivos ausentes ou vazios)"]
    : [snapshot.prompt];
  return [header, ...pathLines, "", ...body].join("\n");
}
