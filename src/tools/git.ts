import { isAbsolute, relative, resolve, sep } from "node:path";
import { createPathClassifier } from "../path-class";
import { PATH_HARD_BLOCKED, denyDisplayPath, resolveArtifactRoot, resolveAstroHome } from "../permissions";
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
const DROP_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_NAMESPACE|GIT_COMMON_DIR|GIT_CONFIG|GIT_CONFIG_SYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_(KEY|VALUE)_\d+|GIT_EXTERNAL_DIFF|GIT_DIFF_OPTS|GIT_PAGER|GIT_SSH_COMMAND)$/i;

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
  env.GIT_LITERAL_PATHSPECS = "1";
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
      // `--literal-pathspecs` é defesa em profundidade contra magic pathspec:
      // `:(top)`, `:/`, `:(exclude)` e `:(glob)` deixam de ser interpretados.
      cmd: ["git", "--literal-pathspecs", ...args],
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
  // Magic pathspec (`:(top)`, `:/`, `:(exclude)`, `:(glob)`) escaparia do cwd.
  if (raw.startsWith(":")) throw new ToolError(`path inválido: pathspec magic não é aceito: ${raw}`);
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
 * Parse do `git diff --name-status -z`: `status\0path\0`, e em rename/copy
 * `status\0old\0new\0`. Devolve todos os paths para a classificação de segurança.
 */
function parseNameStatus(stdout: string): string[] {
  const parts = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (status === undefined || status.length === 0) continue;
    const first = parts[i++];
    if (first === undefined) break;
    paths.push(first);
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = parts[i++];
      if (second !== undefined) paths.push(second);
    }
  }
  return paths;
}

/**
 * ADR-0027: nenhum tool lê conteúdo hard-block, nem via diff. Cada path
 * alterado é classificado sobre o realpath (junction/symlink incluso); um
 * único hard-block recusa o diff inteiro antes de produzir conteúdo.
 */
function hardBlockedPath(paths: readonly string[], repoRoot: string, ctx: ToolContext): string | undefined {
  if (paths.length === 0) return undefined;
  const env = ctx.env ?? process.env;
  const classify = createPathClassifier({
    cwd: ctx.cwd,
    astroHome: resolveAstroHome(env),
    protectedPaths: ctx.protectedPaths,
    artifactRoot: resolveArtifactRoot(env),
  });
  for (const path of paths) {
    const absolute = resolve(repoRoot, path);
    if (classify(absolute) === "hard-block") return denyDisplayPath(ctx.cwd, absolute);
  }
  return undefined;
}

/**
 * Envelope do status com cap em bytes (não só em número de entradas): 500
 * paths longos não podem virar 100k de saída. `total`/`truncated` preservam a
 * contagem real quando o corte acontece.
 */
function boundedStatus(entries: StatusEntry[], total: number): string {
  const serialize = (kept: StatusEntry[]): string => {
    const result: Record<string, unknown> = { clean: total === 0, entries: kept };
    if (total > kept.length) {
      result.total = total;
      result.truncated = true;
    }
    return JSON.stringify(result);
  };
  const budget = MAX_OUTPUT - 128;
  const kept: StatusEntry[] = [];
  let used = 0;
  for (const entry of entries.slice(0, MAX_STATUS_ENTRIES)) {
    const cost = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (used + cost > budget) break;
    kept.push(entry);
    used += cost;
  }
  let output = serialize(kept);
  while (kept.length > 0 && Buffer.byteLength(output, "utf8") > MAX_OUTPUT) {
    kept.pop();
    output = serialize(kept);
  }
  return output;
}

/** Conteúdo binário (NUL/controle) nunca vai para o contexto: vira `(binário)`. */
function sanitizeBinary(body: string): string {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) return "(binário)";
  return body.replace(/^Binary files .* differ\r?$/gm, "(binário)");
}

/** Envelope estruturado do diff; `truncated` é campo, não texto de cabeçalho. */
function diffEnvelope(staged: boolean, base: string | undefined, truncated: boolean, diff: string): string {
  return JSON.stringify({ staged, base: base ?? null, truncated, diff });
}

/**
 * Diff em envelope JSON e cap medido em bytes (o corpo pode crescer com o
 * escape do JSON). Acima do cap, corta com marcador explícito.
 */
function boundedDiff(raw: string, staged: boolean, base: string | undefined): string {
  const body = sanitizeBinary(redactSecrets(raw).replace(/\r\n/g, "\n"));
  const complete = diffEnvelope(staged, base, false, body);
  if (Buffer.byteLength(complete, "utf8") <= MAX_OUTPUT) return complete;

  const marker = (omitted: number): string => `\n[... diff truncado: ${omitted} caracteres omitidos ...]`;
  const build = (keep: number): string =>
    diffEnvelope(staged, base, true, body.slice(0, keep) + marker(body.length - keep));
  // Maior prefixo cujo envelope ainda cabe no cap (escape do JSON incluído).
  let low = 0;
  let high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(build(middle), "utf8") <= MAX_OUTPUT) low = middle;
    else high = middle - 1;
  }
  return build(low);
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
      return { output: boundedStatus(total, total.length) };
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
      const timeout = gitDiffTool.manifest.timeoutMs;
      // Raiz do repo para converter os paths do diff (repo-root) em absolutos.
      const rootOutcome = await runGit(
        ["--no-pager", "--no-optional-locks", "rev-parse", "--show-toplevel"],
        ctx,
        timeout,
      );
      const rootFailed = gitFailure(rootOutcome);
      if (rootFailed !== undefined) return rootFailed;
      const repoRoot = rootOutcome.stdout.trim();

      // Enumera os paths alterados e barra hard-block ANTES de gerar conteúdo.
      const listArgs = [
        "--no-pager", "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--name-status", "-z",
      ];
      if (staged) listArgs.push("--cached");
      if (base !== undefined) listArgs.push(base);
      listArgs.push("--", path);
      const changed = await runGit(listArgs, ctx, timeout);
      const changedFailed = gitFailure(changed);
      if (changedFailed !== undefined) return changedFailed;
      const blocked = hardBlockedPath(parseNameStatus(changed.stdout), repoRoot, ctx);
      if (blocked !== undefined) {
        return {
          output: `diff negado (${PATH_HARD_BLOCKED}): "${blocked}" — conteúdo hard-block não é devolvido (ADR-0027)`,
          isError: true,
          code: PATH_HARD_BLOCKED,
        };
      }

      const args = ["--no-pager", "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "--no-textconv"];
      if (staged) args.push("--cached");
      if (base !== undefined) args.push(base);
      args.push("--", path);
      const outcome = await runGit(args, ctx, timeout);
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
