import { isAbsolute, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../sanitize-external";
import { resolveWithin } from "./paths";
import { sanitizedEnv } from "./run-command";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "./types";

/** Teto de saída da tool; o executor aplica o cap em tokens por cima (CMP-10). */
const MAX_OUTPUT = 10_000;
/** Teto de entradas do status: repositório enorme não vira saída gigante. */
const MAX_STATUS_ENTRIES = 500;
/** Commit-ish aceito em `base`: só 40 hexadecimais, nunca flag/expressão de revisão. */
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Variáveis que redirecionam o repositório, injetam config ou trocam o
 * programa de diff: descartadas antes de spawnar o git (sem
 * `--no-index`, sem diff externo, sem rede).
 */
const DROP_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_CONFIG|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|GIT_PAGER|GIT_SSH_COMMAND)$/i;

/** Erro tipado da tool: vira `ToolResult` com `code`, nunca throw para o executor. */
class GitToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GitToolError";
  }
}

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function failure(message: string): ToolResult {
  return { output: message, isError: true };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto");
  }
  return input as Record<string, unknown>;
}

/**
 * Ambiente do git (I-03): o mesmo sanitizador do shell remove segredos, e o
 * git roda sem config global/de sistema, sem pager, sem prompt e sem lazy
 * fetch. Resultado: read-only, determinístico e sem rede.
 */
export function gitEnv(ctx: ToolContext): Record<string, string> {
  const source = sanitizedEnv((ctx.env ?? process.env) as NodeJS.ProcessEnv, ctx.secretEnvNames ?? []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!DROP_ENV.test(name)) env[name] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_PAGER = "cat";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  return env;
}

/** Lê o pipe do subprocesso; `stdout`/`stderr` só são stream com `"pipe"`. */
async function streamText(stream: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
  return stream === undefined || typeof stream === "number" ? "" : new Response(stream).text();
}

/** Roda `git` por argv (nunca shell), com cwd confinado, timeout e cancelamento. */
async function runGit(args: readonly string[], ctx: ToolContext, timeoutMs: number): Promise<GitOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd: ctx.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(ctx),
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      throw new GitToolError("git_unavailable", "git não encontrado no PATH; instale o Git para usar git_status/git_diff");
    }
    throw error;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = (): void => {
    try {
      proc.kill();
    } catch {
      // já saiu
    }
  };
  const onAbort = (): void => kill();
  if (ctx.signal?.aborted === true) kill();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(kill, timeoutMs);

  try {
    const code = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      streamText(proc.stdout),
      streamText(proc.stderr),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

/** Erro do git vira resultado tipado: repo ausente tem código estável. */
function gitFailure(outcome: GitOutcome): ToolResult | undefined {
  if (outcome.code === 0) return undefined;
  const detail = redactSecrets(outcome.stderr.trim());
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  if (/not a git repository/i.test(detail)) {
    return {
      output: `não é um repositório git (git_not_repo); rode o git init ou use outro cwd${suffix}`,
      isError: true,
      code: "git_not_repo",
    };
  }
  return { output: `git falhou (código ${outcome.code})${suffix}`, isError: true, code: "git_failed" };
}

/**
 * Path do input vira pathspec relativo dentro do cwd (I-11): absoluto, `..`
 * e token começando com `-` são recusados, então nunca viram opção do git.
 */
function relativePath(cwd: string, raw: unknown): string {
  if (raw === undefined || raw === "") return ".";
  if (typeof raw !== "string") throw new ToolError("path inválido: esperado string");
  if (raw.includes("\0")) throw new ToolError("path inválido: contém byte nulo");
  if (raw.startsWith("-")) throw new ToolError(`path inválido: não pode começar com "-": ${raw}`);
  if (isAbsolute(raw)) throw new ToolError(`path inválido: use caminho relativo ao cwd: ${raw}`);
  const target = resolveWithin(cwd, raw);
  const value = relative(resolve(cwd), target);
  return value.length === 0 ? "." : value.split(sep).join("/");
}

/** `base`/`ref` só aceitam commit de 40 hexadecimais; identicamente validados. */
function commitBase(input: Record<string, unknown>): string | undefined {
  const raw = input.base ?? input.ref;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !COMMIT_SHA.test(raw)) {
    throw new ToolError("base inválida: use um commit de 40 hexadecimais (sem nomes de branch, flags ou metacaracteres)");
  }
  if (input.base !== undefined && input.ref !== undefined) {
    const base = String(input.base).toLowerCase();
    const ref = String(input.ref).toLowerCase();
    if (base !== ref) throw new ToolError("base inválida: \"base\" e \"ref\" divergem");
  }
  return raw.toLowerCase();
}

interface StatusEntry {
  index: string;
  worktree: string;
  path: string;
}

/** Separa `count` campos por espaço; o resto (com espaços) é o path. */
function splitFields(record: string, count: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(" ", start);
    if (space < 0) return [];
    fields.push(record.slice(start, space));
    start = space + 1;
  }
  fields.push(record.slice(start));
  return fields;
}

/**
 * Parse do `git status --porcelain=v2 -z`: `1` comum, `2` rename/copy (com o
 * path de origem no registro NUL seguinte), `u` unmerged, `?`/`!` sem XY.
 * `prefix` (`--show-prefix`) converte o path do repo para o path do cwd (I-11).
 */
function parseStatus(stdout: string, prefix: string): StatusEntry[] {
  const strip = (path: string): string =>
    prefix.length > 0 && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const records = stdout.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.length === 0) continue;
    const tag = record[0];
    if (tag === "1" || tag === "2") {
      const fields = splitFields(record, tag === "1" ? 8 : 9);
      const xy = fields[1];
      const path = fields[fields.length - 1];
      if (xy === undefined || path === undefined || fields.length < 9) continue;
      const index = xy[0] ?? ".";
      const worktree = xy[1] ?? ".";
      if (tag === "2") {
        const from = records[++i] ?? "";
        entries.push({ index, worktree, path: `${strip(from)} -> ${strip(path)}` });
      } else {
        entries.push({ index, worktree, path: strip(path) });
      }
    } else if (tag === "u") {
      const fields = splitFields(record, 10);
      const xy = fields[1];
      const path = fields[fields.length - 1];
      if (xy === undefined || path === undefined || fields.length < 11) continue;
      entries.push({ index: xy[0] ?? "U", worktree: xy[1] ?? "U", path: strip(path) });
    } else if (tag === "?" || tag === "!") {
      entries.push({ index: tag, worktree: tag, path: strip(record.slice(2)) });
    }
  }
  return entries;
}

/**
 * Envelope do diff: cabeçalho estável com `truncated`, corpo redigido (I-03)
 * e marcador explícito quando o cap corta o conteúdo.
 */
function boundedDiff(raw: string, staged: boolean, base: string | undefined): string {
  const body = redactSecrets(raw).replace(/\r\n/g, "\n");
  const header = (truncated: boolean): string =>
    `git_diff staged=${staged} base=${base ?? "none"} truncated=${truncated}`;
  if (body.length === 0) return `${header(false)}\n(sem diferenças)`;
  const complete = `${header(false)}\n${body}`;
  if (complete.length <= MAX_OUTPUT) return complete;

  const marker = `[... diff truncado (truncated: true): ${body.length} caracteres no total, exibindo o início ...]`;
  const budget = Math.max(0, MAX_OUTPUT - header(true).length - marker.length - 2);
  return `${header(true)}\n${body.slice(0, budget)}\n${marker}`;
}

/** Estado estruturado do repositório: entradas compactas e confinadas ao cwd. */
export const gitStatusTool: Tool = {
  manifest: {
    name: "git_status",
    description:
      "Mostra o estado estruturado do repositório git no diretório de trabalho " +
      "(index/worktree por path, rename como \"from -> to\"). Somente leitura.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Subdiretório relativo ao cwd (default: \".\").",
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
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const raw = objectInput(input);
      const path = relativePath(ctx.cwd, raw.path);
      // Prefixo do cwd dentro do repo: porcelain v2 sempre reporta path a partir
      // da raiz do repositório, e a saída fica relativa ao cwd confinado.
      const prefixOutcome = await runGit(
        ["--no-pager", "--no-optional-locks", "rev-parse", "--show-prefix"],
        ctx,
        gitStatusTool.manifest.timeoutMs,
      );
      const prefixFailed = gitFailure(prefixOutcome);
      if (prefixFailed !== undefined) return prefixFailed;
      const prefix = prefixOutcome.stdout.trim();
      // `--` + pathspec: o git nunca interpreta o path como opção e o cwd é o teto.
      const outcome = await runGit(
        ["--no-pager", "--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=normal", "--", path],
        ctx,
        gitStatusTool.manifest.timeoutMs,
      );
      const failed = gitFailure(outcome);
      if (failed !== undefined) return failed;

      const total = parseStatus(outcome.stdout, prefix);
      const entries = total.slice(0, MAX_STATUS_ENTRIES);
      const result: Record<string, unknown> = { clean: total.length === 0, entries };
      if (total.length > entries.length) {
        result.total = total.length;
        result.truncated = true;
      }
      return { output: JSON.stringify(result) };
    } catch (error) {
      if (error instanceof GitToolError) {
        return { output: error.message, isError: true, code: error.code };
      }
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no git_status: ${message}`);
    }
  },
};

/** Diff unificado do worktree ou do index, confinado ao cwd e limitado. */
export const gitDiffTool: Tool = {
  manifest: {
    name: "git_diff",
    description:
      "Mostra o diff unificado do worktree (ou do index com staged) limitado ao " +
      "diretório de trabalho. `base` aceita só commit de 40 hexadecimais. Somente leitura.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Arquivo ou subdiretório relativo ao cwd (default: \".\").",
        },
        staged: {
          type: "boolean",
          description: "Compara o index (--cached) em vez do worktree; default false.",
        },
        base: {
          type: "string",
          description: "Commit de 40 hexadecimais para comparar; default o index/worktree.",
        },
        ref: {
          type: "string",
          description: "Alias de `base`, com a mesma validação.",
        },
      },
      required: [],
    },
    risk: "low",
    permission: "read",
    class: "read_common",
    timeoutMs: 30_000,
    retryable: true,
    idempotent: true,
    sideEffects: "none",
  },

  async execute(input, ctx): Promise<ToolResult> {
    try {
      const raw = objectInput(input);
      const base = commitBase(raw);
      const staged = raw.staged === true;
      const path = relativePath(ctx.cwd, raw.path);
      const args = ["--no-pager", "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      if (staged) args.push("--cached");
      if (base !== undefined) args.push(base);
      args.push("--", path);
      const outcome = await runGit(args, ctx, gitDiffTool.manifest.timeoutMs);
      const failed = gitFailure(outcome);
      if (failed !== undefined) return failed;
      return { output: boundedDiff(outcome.stdout, staged, base) };
    } catch (error) {
      if (error instanceof GitToolError) {
        return { output: error.message, isError: true, code: error.code };
      }
      if (error instanceof ToolError) return failure(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no git_diff: ${message}`);
    }
  },
};
