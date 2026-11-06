import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyPath } from "../path-class";
import { resolveArtifactRoot, resolveAstroHome } from "../permissions";
import { redactSecrets } from "../sanitize-external";
import { realpathPreservingDots } from "./paths";
import { ToolError, type Tool, type ToolResult } from "./types";

const MAX_OUTPUT = 10_000;

/**
 * Nomes de variáveis que podem carregar segredos. O `run_command` recebe uma
 * cópia sanitizada do ambiente: o filho mantém PATH/HOME/etc., mas nunca vê
 * chaves de API, tokens, senhas ou credenciais.
 */
const SECRET_ENV =
  /(^|_)[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|PEM|AUTH|CREDENTIAL|PRIVATE|COOKIE|SESSION)[A-Z0-9_]*$/i;

/**
 * Nomes que casam com `SECRET_ENV` (contêm AUTH) mas não são segredo:
 * identidade git. Exceção explícita para não regredir I-03 em AUTHORIZATION.
 */
const NON_SECRET_ENV = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_EMAIL",
]);

function secretKey(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

export function sanitizedEnv(
  source: NodeJS.ProcessEnv,
  secretEnvNames: readonly string[] = [],
): Record<string, string> {
  const exactSecrets = new Set(secretEnvNames.map(secretKey));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      exactSecrets.has(secretKey(name)) ||
      (SECRET_ENV.test(name) && !NON_SECRET_ENV.has(name.toUpperCase()))
    ) continue;
    env[name] = value;
  }
  return env;
}
/**
 * Imagem default do sandbox (ADR-0027): carrega só toolchain (`bun`, `tsc`) e
 * dependências — nunca código do projeto nem item do hard-block. Produção deve
 * fixar por digest via env `ASTRO_DOCKER_IMAGE` (`oven/bun:1.4.2@sha256:...`);
 * o digest não é embutido no código de propósito.
 */
const DEFAULT_DOCKER_IMAGE = "oven/bun:1.4.2";

/** Imagem do container do sandbox; override por env `ASTRO_DOCKER_IMAGE`. */
export function resolveDockerImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ASTRO_DOCKER_IMAGE?.trim();
  return override === undefined || override === "" ? DEFAULT_DOCKER_IMAGE : override;
}

function failure(message: string): ToolResult {
  return { output: redactSecrets(message), isError: true };
}

function commandInput(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new ToolError("entrada inválida: esperado objeto com { command }");
  }
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ToolError("entrada inválida: \"command\" deve ser uma string não vazia");
  }
  return command;
}

function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["/bin/sh", "-c", command];
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) : text;
}

/**
 * ADR-0027 (redação): toda saída do comando redige padrões de segredo ANTES
 * de qualquer truncamento — o cap nunca devolve texto cru (I-03).
 */
function redactThenTruncate(text: string): string {
  return truncate(redactSecrets(text));
}

/** Mata o processo e os filhos (taskkill /T no Windows; grupo no POSIX). */
function killProcessTree(proc: { pid: number; kill: () => void }): void {
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    } catch {
      try {
        proc.kill();
      } catch {
        // já saiu
      }
    }
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill();
    } catch {
      // já saiu
    }
  }
}

// --- Sandbox (F4-6) ---

let sandboxEnabled = false;
let dockerProbe: Promise<boolean> | undefined;

/**
 * Só aceita engine Linux: no Windows o Docker Desktop pode estar em modo
 * Windows containers, que não roda `alpine` nem suporta `--read-only`.
 */
export function dockerInfoSupportsLinuxContainers(output: string): boolean {
  const [version, osType] = output.trim().split("|");
  return (version?.trim().length ?? 0) > 0 && osType?.trim().toLowerCase() === "linux";
}

/**
 * Verifica se o binário `docker` existe, o daemon responde (`docker info`) e o
 * engine roda containers Linux. Resultado cacheado por processo.
 */
export function detectDockerAvailable(): Promise<boolean> {
  if (dockerProbe === undefined) {
    dockerProbe = (async () => {
      try {
        const proc = Bun.spawn({
          cmd: ["docker", "info", "--format", "{{.ServerVersion}}|{{.OSType}}"],
          stdout: "pipe",
          stderr: "pipe",
          env: minimalHostEnv(),
        });
        const timer = setTimeout(() => proc.kill(), 5_000);
        try {
          const code = await proc.exited;
          if (code !== 0) return false;
          return dockerInfoSupportsLinuxContainers(await new Response(proc.stdout).text());
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return false;
      }
    })();
  }
  return dockerProbe;
}

/** Env mínimo para spawnar o docker CLI: sem credenciais do host. */
function minimalHostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SYSTEMROOT !== undefined) env.SYSTEMROOT = process.env.SYSTEMROOT;
  return env;
}

/** Configura o modo sandbox de run_command (chamado pelo app ao carregar a config). */
export function configureRunCommand(opts: { sandbox?: boolean }): void {
  sandboxEnabled = opts.sandbox === true;
}

/** Estado atual do sandbox do run_command (diagnóstico e testes). */
export function isRunCommandSandboxEnabled(): boolean {
  return sandboxEnabled;
}

/**
 * Sandbox ligado salvo opt-out explícito (`sandbox: false`). Sem Docker,
 * `run_command` recusa em vez de rodar sem isolamento (I-11).
 */
export function resolveSandboxSetting(configured: boolean | undefined): boolean {
  return configured !== false;
}

/** Limites da varredura de máscaras (ADR-0027): profundidade máxima e teto de entradas. */
const MASK_MAX_DEPTH = 12;
const MASK_MAX_ENTRIES = 20_000;

/** Contexto mínimo para montar o argv do sandbox (subconjunto de `ToolContext`). */
export interface DockerSandboxContext {
  cwd: string;
  env?: Record<string, string | undefined>;
  protectedPaths?: readonly string[];
}

interface MaskTarget {
  /** Caminho no host (== caminho no container, o cwd é bindado 1:1) a mascarar. */
  target: string;
  isDirectory: boolean;
}

/**
 * Classificação para máscara (ADR-0027): fail-closed — erro de `classifyPath`
 * vira hard-block, então o que não pôde ser inspecionado também é mascarado.
 */
function classifyForMask(
  realPath: string,
  cwd: string,
  astroHome: string,
  artifactRoot: string | null,
  protectedPaths: readonly string[] | undefined,
): boolean {
  try {
    return classifyPath({ realPath, cwd, astroHome, artifactRoot, protectedPaths, allowCritical: [] }) === "hard-block";
  } catch {
    return true; // fail-closed
  }
}

/** `stat` do alvo; fail-closed: erro que não seja "não existe" vira máscara de diretório. */
function maskTargetOf(path: string): MaskTarget | null {
  try {
    return { target: path, isDirectory: statSync(path).isDirectory() };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null; // não existe: nada a encobrir
    return { target: path, isDirectory: true };
  }
}

/**
 * Alvos de máscara hard-block (ADR-0027): `<cwd>/.git` sempre (arquivo em
 * worktree, árvore em repo — git não roda no sandbox), o `ASTRO_ARTIFACT_ROOT`
 * pelo realpath e todo path hard-block existente dentro do cwd. Varredura com
 * limites: profundidade máx `MASK_MAX_DEPTH`, teto `MASK_MAX_ENTRIES` (excedido
 * = recusa fail-closed), sem descer em symlink e sem descer em diretório já
 * mascarado (a máscara de árvore já o encobre inteiro).
 */
function collectMaskTargets(ctx: DockerSandboxContext, env: NodeJS.ProcessEnv): MaskTarget[] {
  const cwd = resolve(ctx.cwd);
  const astroHome = resolveAstroHome(env);
  const artifactRoot = resolveArtifactRoot(env);
  const targets = new Map<string, MaskTarget>();
  const add = (path: string): void => {
    const target = maskTargetOf(path);
    if (target !== null) targets.set(target.target, target);
  };

  add(join(cwd, ".git"));
  if (artifactRoot !== null) add(realpathPreservingDots(artifactRoot, cwd));

  let entries = 0;
  const pending: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    let names: Dirent[];
    try {
      names = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue; // diretório ilegível: não desce; os itens acima já foram classificados
    }
    for (const entry of names) {
      entries += 1;
      if (entries > MASK_MAX_ENTRIES) {
        throw new ToolError(`sandbox: varredura de máscaras excedeu o teto de ${MASK_MAX_ENTRIES} entradas`);
      }
      const full = join(current.dir, entry.name);
      if (classifyForMask(full, cwd, astroHome, artifactRoot, ctx.protectedPaths)) {
        add(full);
        continue;
      }
      if (!entry.isSymbolicLink() && entry.isDirectory() && current.depth < MASK_MAX_DEPTH) {
        pending.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return [...targets.values()];
}

/**
 * Fontes vazias das máscaras (ADR-0027): criadas em `os.tmpdir()` (fora do cwd
 * e do artifactRoot) — arquivo vazio para alvo arquivo, diretório vazio para
 * alvo diretório — e montadas `:ro` no mesmo caminho dentro do container.
 */
function maskMounts(ctx: DockerSandboxContext, env: NodeJS.ProcessEnv): string[] {
  const targets = collectMaskTargets(ctx, env);
  if (targets.length === 0) return [];
  const maskRoot = mkdtempSync(join(tmpdir(), "astro-sandbox-mask-"));
  try {
    chmodSync(maskRoot, 0o700); // 0700 no POSIX; no Windows os bits são best-effort
  } catch {
    // best-effort
  }
  const mounts: string[] = [];
  let index = 0;
  for (const target of targets) {
    const source = join(maskRoot, `mask-${index++}`);
    if (target.isDirectory) {
      mkdirSync(source, { mode: 0o700 });
    } else {
      writeFileSync(source, "", { mode: 0o600 });
    }
    mounts.push("--volume", `${source}:${target.target}:ro`);
  }
  return mounts;
}

/**
 * Argv do docker run com isolamento (ADR-0027, I-11): rede off, rootfs
 * read-only, `/tmp` em tmpfs rw/noexec/nosuid, cwd read-write, git
 * neutralizado (`GIT_DIR=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME=/tmp`) e
 * máscara read-only para cada hard-block dentro do cwd (mais `.git` e o
 * artifactRoot). Exportado para teste.
 */
export function dockerArgv(containerName: string, ctx: DockerSandboxContext, command: string): string[] {
  const workdir = resolve(ctx.cwd);
  const env = ctx.env ?? process.env;
  return [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--env",
    "GIT_DIR=/dev/null",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    "--env",
    "HOME=/tmp",
    "--volume",
    `${workdir}:${workdir}`,
    ...maskMounts(ctx, env),
    "--workdir",
    workdir,
    resolveDockerImage(env),
    "sh",
    "-c",
    command,
  ];
}

/** Executa um comando dentro do container Docker efêmero. */
async function runInDocker(command: string, ctx: { cwd: string; signal?: AbortSignal }, timeoutMs: number): Promise<ToolResult> {
  const containerName = `astro-sb-${randomUUID().slice(0, 12)}`;
  const proc = Bun.spawn({
    cmd: dockerArgv(containerName, ctx, command),
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: minimalHostEnv(),
    detached: ctx.signal !== undefined && process.platform !== "win32",
  });

  const removeContainer = (): void => {
    try {
      Bun.spawnSync(["docker", "rm", "-f", containerName], {
        stdout: "ignore", stderr: "ignore", env: minimalHostEnv(),
      });
    } catch {
      // best-effort
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  const aborted = Symbol("aborted");
  const timeout = new Promise<typeof timedOut>((res) => {
    timer = setTimeout(() => {
      killProcessTree(proc);
      res(timedOut);
    }, timeoutMs);
  });
  let onCancel: (() => void) | undefined;
  const cancellation = new Promise<typeof aborted>((resolve) => {
    if (ctx.signal === undefined) return;
    if (ctx.signal.aborted) {
      killProcessTree(proc);
      resolve(aborted);
      return;
    }
    onCancel = (): void => {
      killProcessTree(proc);
      resolve(aborted);
    };
    ctx.signal.addEventListener("abort", onCancel, { once: true });
  });

  let exited: typeof timedOut | typeof aborted | number;
  try {
    exited = await Promise.race([proc.exited, timeout, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onCancel !== undefined) ctx.signal?.removeEventListener("abort", onCancel);
  }

  if (exited === aborted) {
    removeContainer();
    return { output: "comando cancelado no sandbox", isError: true };
  }

  if (exited === timedOut) {
    // docker run morto não para o container: limpeza forçada best-effort
    removeContainer();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const chunks = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0);
  let output = chunks.join("\n");

  if (exited === timedOut) {
    const note = `timeout de ${timeoutMs}ms excedido no sandbox; container interrompido`;
    output = output.length > 0 ? `${output}\n${note}` : note;
    return { output: redactThenTruncate(output), isError: true };
  }
  if (exited !== 0) {
    const note = `comando terminou com código ${exited} (sandbox docker)`;
    output = output.length > 0 ? `${output}\n${note}` : note;
    return { output: redactThenTruncate(output), isError: true };
  }
  return { output: redactThenTruncate(output) };
}

/** Executa um comando de shell no diretório de trabalho, com timeout do manifesto. */
export const runCommandTool: Tool = {
  manifest: {
    name: "run_command",
    description:
      "Executa um comando de shell no diretório de trabalho e devolve a saída. " +
      "Com tools.run_command.sandbox ativo, executa em container Docker efêmero " +
      "isolado (sem rede, rootfs read-only, cwd read-write).",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Comando a executar no shell do sistema.",
        },
      },
      required: ["command"],
    },
    risk: "high",
    permission: "execute",
    class: "shell",
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    sideEffects: "process",
  },

  async execute(input, ctx): Promise<ToolResult> {
    let command: string;
    try {
      command = commandInput(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(message);
    }

    // Sandbox: container Docker efêmero; sem Docker disponível, recusa (sem downgrade)
    if (sandboxEnabled) {
      const docker = await detectDockerAvailable();
      if (!docker) {
        return failure(
          "sandbox ativo (tools.run_command.sandbox) mas Docker não está disponível; " +
            "instale e inicie o Docker ou desative o sandbox na configuração",
        );
      }
      try {
        return await runInDocker(command, ctx, runCommandTool.manifest.timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`erro no sandbox docker: ${message}`);
      }
    }

    try {
      const proc = Bun.spawn({
        cmd: shellArgv(command),
        cwd: ctx.cwd,
        env: sanitizedEnv(ctx.env ?? process.env, ctx.secretEnvNames ?? []),
        stdout: "pipe",
        stderr: "pipe",
        detached: ctx.signal !== undefined && process.platform !== "win32",
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timeout");
      const aborted = Symbol("aborted");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => {
          killProcessTree(proc);
          resolve(timedOut);
        }, runCommandTool.manifest.timeoutMs);
      });
      const onAbort = (): void => {
        killProcessTree(proc);
      };
      let onCancel: (() => void) | undefined;
      const cancellation = new Promise<typeof aborted>((resolve) => {
        if (ctx.signal === undefined) return;
        if (ctx.signal.aborted) {
          killProcessTree(proc);
          resolve(aborted);
          return;
        }
        onCancel = (): void => resolve(aborted);
        ctx.signal.addEventListener("abort", onCancel, { once: true });
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      });

      let exited: typeof timedOut | typeof aborted | number;
      try {
        exited = await Promise.race([proc.exited, timeout, cancellation]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        if (onCancel !== undefined) ctx.signal?.removeEventListener("abort", onCancel);
      }

      if (exited === aborted) {
        return { output: "comando cancelado", isError: true };
      }

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const chunks = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0);
      let output = chunks.join("\n");

      if (exited === timedOut) {
        const note = `timeout de ${runCommandTool.manifest.timeoutMs}ms excedido; comando interrompido`;
        output = output.length > 0 ? `${output}\n${note}` : note;
        return { output: redactThenTruncate(output), isError: true };
      }

      if (exited !== 0) {
        const note = `comando terminou com código ${exited}`;
        output = output.length > 0 ? `${output}\n${note}` : note;
        return { output: redactThenTruncate(output), isError: true };
      }

      return { output: redactThenTruncate(output) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro ao executar comando: ${message}`);
    }
  },
};