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

/** Piso de `memory.maxChars`: abaixo disso o marcador de corte não cabe inteiro. */
export const MIN_MEMORY_MAX_CHARS = 200;

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
  /** `false` omite a linha que ensina `memory_write` (tool fora da allowlist). */
  memoryWriteAllowed?: boolean;
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
 * Índices das linhas que abrem uma seção de nível 2 (`## `), ignorando o que
 * está dentro de code fence ``` ou ~~~. É a única regra de split do módulo:
 * loader, detecção de fim de corpo em `memory_write` e validação do texto novo
 * usam esta função, então `## ` dentro de bloco de código nunca vira seção.
 */
export function topLevelHeadingIndexes(lines: readonly string[]): number[] {
  const headings: number[] = [];
  let fence: { char: string; length: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === undefined) {
      // Info string de fence com backtick não abre bloco (CommonMark).
      if (marker !== null && !(marker[1]!.startsWith("`") && marker[2]!.includes("`"))) {
        fence = { char: marker[1]![0]!, length: marker[1]!.length };
        continue;
      }
      if (/^##\s/.test(line)) headings.push(index);
      continue;
    }
    if (marker !== null && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === "") {
      fence = undefined;
    }
  }
  return headings;
}

function lineStarts(text: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/**
 * Divide o texto em blocos de seção: o preâmbulo (antes do primeiro `## `) e
 * cada `## título` até o próximo heading de mesmo nível, respeitando fences. O
 * bloco inteiro entra ou fica de fora - nunca um pedaço.
 */
export function splitMemoryChunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headings = topLevelHeadingIndexes(lines);
  const starts = lineStarts(normalized);
  const cuts = [0, ...headings];
  const chunks: string[] = [];
  for (let index = 0; index < cuts.length; index++) {
    const from = cuts[index]!;
    const to = index + 1 < cuts.length ? starts[cuts[index + 1]!]! : normalized.length;
    if (to <= starts[from]!) continue;
    const chunk = normalized.slice(starts[from]!, to).replace(/\s+$/, "");
    if (chunk.trim().length > 0) chunks.push(chunk);
  }
  return chunks;
}

/** `true` quando o texto traz um `## ` de nível 2 fora de code fence. */
export function hasTopLevelHeading(text: string): boolean {
  return topLevelHeadingIndexes(text.replace(/\r\n/g, "\n").split("\n")).length > 0;
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
    return splitMemoryChunks(text).map((chunk) => ({ scope, path, text: chunk }));
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

function compose(blocks: readonly MemoryBlock[], marker: string | undefined, hint: string | undefined): string {
  const parts = [MEMORY_HEADING];
  if (hint !== undefined) parts.push("", hint);
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
function fitChunks(chunks: readonly Chunk[], maxChars: number, hint: string | undefined): Fit {
  for (let count = chunks.length; count >= 0; count--) {
    const kept = chunks.slice(0, count);
    const omitted = chunks.slice(count);
    const marker = omitted.length === 0 ? undefined : memoryTruncationMarker(bytesOf(omitted));
    const truncatedPaths = new Set(omitted.map((chunk) => chunk.path));
    const prompt = compose(groupChunks(kept, truncatedPaths), marker, hint);
    if (prompt.length <= maxChars) return { blocks: groupChunks(kept, truncatedPaths), omitted, prompt };
  }
  // Nem o cabeçalho cabe no teto: só o marcador, cortado - nenhuma seção pela metade.
  const marker = memoryTruncationMarker(bytesOf(chunks));
  return { blocks: [], omitted: [...chunks], prompt: marker.slice(0, Math.max(maxChars, marker.length)) };
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
  // Piso de 200 (MIN_MEMORY_MAX_CHARS): abaixo disso o marcador de corte não
  // caberia inteiro e o prompt receberia um marcador pela metade.
  const maxChars = Math.max(MIN_MEMORY_MAX_CHARS, Math.floor(opts.maxChars ?? DEFAULT_MEMORY_MAX_CHARS));
  const hint = opts.memoryWriteAllowed === false ? undefined : MEMORY_HINT;
  const chunks = [
    ...(readMemoryFile("global", paths.global, resolve(resolveAstroHome(env)), [], warn) ?? []),
    ...(readMemoryFile("project", paths.project, resolve(opts.cwd), [], warn) ?? []),
  ];

  if (chunks.length === 0) {
    return { paths, maxChars, blocks: [], truncated: false, usedChars: 0, remainingChars: maxChars, warnings };
  }

  const fit = fitChunks(chunks, maxChars, hint);
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
