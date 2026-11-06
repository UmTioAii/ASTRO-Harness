import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyPath } from "../path-class";
import { resolveArtifactRoot, resolveAstroHome } from "../permissions";
import { redactSecrets } from "../sanitize-external";
import { ToolError, type Tool, type ToolResult } from "./types";

const MAX_OUTPUT = 10_000;

/**
 * Nomes de variáveis que podem carregar segredos. Desde a slice 4 o shell
 * nunca roda no host (sandbox obrigatório), então o container não recebe env
 * do host; este helper continua como contrato de env sanitizado coberto pelos
 * testes e reutilizável por caminhos futuros que spawn no host (I-03).
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
 * Imagem default do sandbox (ADR-0027 slice 4): só toolchain (`bun`/`tsc`) e
 * deps do lockfile — sem código do projeto, sem hard-block, **sem git**.
 * Override: env `ASTRO_DOCKER_IMAGE`; produção fixa a imagem por digest nesse
 * env (`nome@sha256:...`). O default é só p/ dev/testes, não é pin de supply-chain.
 */
const DEFAULT_DOCKER_IMAGE = "oven/bun:1.4.2";

/** Imagem do container: env `ASTRO_DOCKER_IMAGE` ou default com toolchain. */
function resolveDockerImage(env: NodeJS.ProcessEnv = process.env): string {
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
 * Windows containers, que não roda a imagem do sandbox nem suporta `--read-only`.
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

/** Limites do walk de máscaras para não travar em árvores grandes (ADR-0027). */
const MASK_WALK_MAX_DEPTH = 12;
const MASK_WALK_MAX_ENTRIES = 20_000;

interface MaskTarget {
  target: string;
  directory: boolean;
}

type DockerCtx = { cwd: string; protectedPaths?: readonly string[]; signal?: AbortSignal };

/**
 * ADR-0027 slice 4: alvos de máscara no cwd. Percorre o cwd (limitado em
 * profundidade/entradas; não pula `node_modules`, pois hard-block pode estar
 * dentro dele), classifica cada path existente com `classifyPath` e
 * `hard-block` vira máscara — falha de classificação também (fail-closed).
 * `.git` do cwd é sempre mascarado (arquivo em worktree, árvore em repo) e o
 * `artifactRoot` (env `ASTRO_ARTIFACT_ROOT`), se existente, é mascarado onde
 * estiver (ADR-0026: nunca fonte de shell). `$ASTRO_HOME` segue hard-block
 * via `classifyPath`.
 */
function collectMaskTargets(workdir: string, env: NodeJS.ProcessEnv, protectedPaths: readonly string[]): MaskTarget[] {
  const astroHome = resolveAstroHome(env);
  const artifactRoot = resolveArtifactRoot(env);
  const targets = new Map<string, boolean>();
  const addIfExists = (path: string): void => {
    try {
      targets.set(path, statSync(path).isDirectory());
    } catch {
      // inexistente: nada a mascarar
    }
  };
  const isHardBlock = (path: string): boolean => {
    try {
      // allowCritical vazio nesta slice (a flag de CLI entra na slice 5)
      return classifyPath({ realPath: path, cwd: workdir, astroHome, artifactRoot, protectedPaths, allowCritical: [] }) === "hard-block";
    } catch {
      return true; // fail-closed: não classificável é mascarado
    }
  };
  // `.git` sempre mascarado: git não roda no sandbox (ADR-0027)
  addIfExists(join(workdir, ".git"));
  if (artifactRoot !== null) {
    try {
      addIfExists(realpathSync(artifactRoot)); // mascarado onde estiver; inexistente não quebra
    } catch {
      // sem artifactRoot existente: nada a mascarar
    }
  }
  let visited = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: workdir, depth: 0 }];
  while (stack.length > 0 && visited < MASK_WALK_MAX_ENTRIES) {
    const current = stack.pop() as { dir: string; depth: number };
    let entries: Dirent[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue; // ilegível: próximo ramo
    }
    for (const entry of entries) {
      if (visited >= MASK_WALK_MAX_ENTRIES) break;
      visited += 1;
      const full = join(current.dir, entry.name);
      if (isHardBlock(full)) {
        addIfExists(full); // a máscara cobre a subárvore: não desce
        continue;
      }
      // symlink não é seguido (ciclo/escape); só diretório real desce
      if (entry.isDirectory() && current.depth < MASK_WALK_MAX_DEPTH) {
        stack.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return [...targets.entries()].map(([target, directory]) => ({ target, directory }));
}

/**
 * Fontes vazias das máscaras em `os.tmpdir()` (fora do cwd/artifactRoot,
 * 0700/0600 best-effort) + mounts `ro`. Falha ao criar fonte propaga:
 * fail-closed, o caller recusa o run.
 */
function materializeMasks(targets: readonly MaskTarget[]): { mounts: [string, string][]; cleanup: () => void } {
  const maskRoot = mkdtempSync(join(tmpdir(), "astro-sb-mask-"));
  const mounts: [string, string][] = [];
  for (const [index, { target, directory }] of targets.entries()) {
    const source = join(maskRoot, `m${index}`);
    if (directory) mkdirSync(source, { recursive: true });
    else writeFileSync(source, "");
    try {
      chmodSync(source, directory ? 0o700 : 0o600);
    } catch {
      // best-effort (Windows não suporta bits POSIX)
    }
    mounts.push([source, target]);
  }
  const cleanup = (): void => {
    try {
      rmSync(maskRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  return { mounts, cleanup };
}

export interface DockerRunPlan {
  argv: string[];
  /** Remove as fontes temporárias das máscaras (chamar ao fim do run). */
  cleanup: () => void;
}

/**
 * Argv do `docker run` isolado (ADR-0027 slice 4): rede off, rootfs
 * `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid`, cwd rw e máscaras `ro`
 * stat-based (arquivo vazio / árvore vazia) p/ hard-block no cwd, `.git` e
 * `artifactRoot`. Git off: `GIT_DIR=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` (a
 * imagem default não embute git). Testável sem Docker: basta ler o argv.
 */
export function dockerArgv(containerName: string, cwd: string, command: string, opts: { env?: NodeJS.ProcessEnv; protectedPaths?: readonly string[] } = {}): DockerRunPlan {
  const env = opts.env ?? process.env;
  const workdir = resolve(cwd);
  const { mounts, cleanup } = materializeMasks(collectMaskTargets(workdir, env, opts.protectedPaths ?? []));
  const argv = [
    "docker",
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid",
    // git indisponível (ADR-0027): além da máscara, o env falha fechado
    "--env",
    "GIT_DIR=/dev/null",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    // HOME gravável via tmpfs /tmp (cache do bun p/ `bun test`/`typecheck`)
    "--env",
    "HOME=/tmp",
    "--volume",
    `${workdir}:${workdir}`,
    ...mounts.flatMap(([source, target]) => ["--volume", `${source}:${target}:ro`]),
    "--workdir",
    workdir,
    resolveDockerImage(env),
    "sh",
    "-c",
    command,
  ];
  return { argv, cleanup };
}

/** Executa um comando dentro do container Docker efêmero (máscaras incluídas). */
async function runInDocker(command: string, ctx: DockerCtx, timeoutMs: number): Promise<ToolResult> {
  const containerName = `astro-sb-${randomUUID().slice(0, 12)}`;
  const plan = dockerArgv(containerName, ctx.cwd, command, { protectedPaths: ctx.protectedPaths });
  try {
    return await runDockerProcess(plan.argv, containerName, ctx, timeoutMs);
  } finally {
    plan.cleanup(); // fontes temporárias das máscaras
  }
}

/** Roda o argv do docker efêmero; converte saída/timeout/abort em ToolResult. */
async function runDockerProcess(argv: string[], containerName: string, ctx: { cwd: string; signal?: AbortSignal }, timeoutMs: number): Promise<ToolResult> {
  const proc = Bun.spawn({
    cmd: argv,
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
      "isolado (sem rede, rootfs read-only, /tmp tmpfs, máscaras de hard-block, cwd read-write). " +
      "Com sandbox desativado, recusa sem executar (sandbox_required_for_shell).",
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

    // ADR-0027 slice 4 (I-11/I-19): `sandbox: false` NÃO executa no host.
    // Recusa fail-closed com o código `sandbox_required_for_shell`, em pt-BR
    // e sem ecoar o comando (I-03). A classe de erro tipada fica para a slice 5.
    return failure(
      "sandbox obrigatório para executar shell (sandbox_required_for_shell): " +
        "tools.run_command.sandbox está desativado e nenhum comando executa fora do container",
    );
  },
};