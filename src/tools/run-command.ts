import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLexicalHardBlockPrefilter, createPathClassifier, type PathClassifier } from "../path-class";
import { DEFAULT_PERMISSION_MODE, resolveArtifactRoot, resolveAstroHome, setPerCallApproval, type ApprovalDetail, type PermissionMode } from "../permissions";
import { redactSecrets } from "../sanitize-external";
import { isSecretEnvName } from "../secrets";
import { detectHostShells, hostShellArgv, selectHostShell } from "./host-shell";
import { realpathPreservingDots } from "./paths";
import { ToolError, type AuditLike, type Tool, type ToolContext, type ToolResult } from "./types";

/** Teto da saída devolvida ao modelo (run_command e run_tests). */
export const MAX_OUTPUT = 10_000;

/**
 * Nomes de variáveis que podem carregar segredos vivem em `secrets.ts`
 * (`isSecretEnvName`) e são compartilhados com o screening de MCP (#496).
 */

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
      isSecretEnvName(name)
    ) continue;
    env[name] = value;
  }
  return env;
}
/** Imagem default do sandbox (ADR-0027); override `ASTRO_DOCKER_IMAGE` (produção: fixar por digest). */
const DEFAULT_DOCKER_IMAGE = "oven/bun:1.4.2";

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
/** Estado do #474 (opt-in `sandbox: "auto"`): modo, modo de permissão e `shell.default`. */
let commandMode: RunCommandMode = "auto";
let permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE;
let preferredShell: string | undefined;
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
export function configureRunCommand(opts: {
  sandbox?: boolean;
  /** Modo resolvido (#474); `sandbox` continua aceito para compatibilidade dos chamadores. */
  mode?: RunCommandMode;
  /** Modo de permissão corrente: decide a exigência extra do host em `bypass` (#474). */
  permissionMode?: PermissionMode;
  /** `shell.default` da config (#474); ausente = ordem da plataforma. */
  shellDefault?: string;
}): void {
  commandMode = opts.mode ?? (opts.sandbox === false ? "disabled" : opts.sandbox === true ? "docker" : "auto");
  permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  preferredShell = opts.shellDefault;
  // `sandbox: true` mantém o caminho Docker byte a byte; `isRunCommandSandboxEnabled`
  // segue significando "Docker", como antes.
  sandboxEnabled = commandMode === "docker";
  // #474: em `auto` o shell pode cair no host, então `shell` deixa de aceitar
  // grant de sessão - cada comando pede aprovação mostrando o comando.
  setPerCallApproval("shell", commandMode === "auto");
}

/** Estado atual do sandbox do run_command (diagnóstico e testes). */
export function isRunCommandSandboxEnabled(): boolean {
  return sandboxEnabled;
}

/** Modo efetivo do `run_command` (#474): auto (default), Docker ou desligado. */
export type RunCommandMode = "auto" | "docker" | "disabled";

/**
 * Resolve `tools.run_command.sandbox` (#474): ausente e `"auto"` = Docker quando
 * disponível, senão host com aprovação por comando (default); `true`/`"docker"`
 * = só container Docker; `false` = shell desligado (I-19).
 */
export function resolveRunCommandMode(configured: boolean | "auto" | "docker" | undefined): RunCommandMode {
  if (configured === false) return "disabled";
  if (configured === true || configured === "docker") return "docker";
  return "auto";
}

/**
 * Confirmação extra para o host em `bypass` (#474). Em `bypass` o gate não
 * pergunta nada; sem esta variável o host recusa, porque o comando rodaria sem
 * nenhuma revisão humana. O modelo nunca controla o ambiente do processo.
 */
export const HOST_SHELL_BYPASS_CONFIRMATION_ENV = "ASTRO_HOST_SHELL_CONFIRM_BYPASS";

/**
 * Shell ligado salvo opt-out explícito (`sandbox: false`, I-19). O default é
 * `auto` (#474): Docker quando disponível, senão host com aprovação por comando.
 */
export function resolveSandboxSetting(configured: boolean | "auto" | "docker" | undefined): boolean {
  // `"auto"` conta como shell ligado; só `false` desliga.
  return configured !== false;
}

/** Aviso de boot/banner (ADR-0027): `sandbox:false` desliga o shell, sem afetar file tools. */
export const SANDBOX_DISABLED_WARNING =
  "run_command desligado (sandbox:false): shell não executa; file tools mantêm hard-block e redação";

/** Erro tipado da recusa de shell sem sandbox (ADR-0027): não ecoa o comando (I-03). */
export class SandboxRequiredForShellError extends Error {
  readonly code = "sandbox_required_for_shell";
  constructor(readonly mode = "sandbox:false", readonly tool = "run_command") {
    super(`sandbox_required_for_shell: ${tool} não executa no host (modo ${mode}); ative tools.run_command.sandbox com Docker`);
    this.name = "SandboxRequiredForShellError";
  }
}

/** Texto do aviso de boot quando o sandbox está desligado. */
export function sandboxWarning(enabled: boolean): string | undefined {
  return enabled ? undefined : SANDBOX_DISABLED_WARNING;
}

/** Teto de entradas da varredura de máscaras (ADR-0027); excedido = recusa fail-closed. */
const MASK_MAX_ENTRIES = 200_000;

/** Contexto mínimo para montar o argv do sandbox (subconjunto de `ToolContext`). */
export interface DockerSandboxContext {
  cwd: string;
  env?: Record<string, string | undefined>;
  protectedPaths?: readonly string[];
  /** `allow-critical` da CLI (slice 5a): path liberado não vira máscara. */
  allowCritical?: readonly string[];
}

interface MaskTarget {
  /** Caminho no host (== caminho no container, o cwd é bindado 1:1) a mascarar. */
  target: string;
  isDirectory: boolean;
}

/** Fail-closed (ADR-0027): erro do classificador vira hard-block (mascara o que não inspecionou). */
function classifyForMask(classify: PathClassifier, realPath: string): boolean {
  try {
    return classify(realPath) === "hard-block";
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
 * Alvos de máscara (ADR-0027): `<cwd>/.git` sempre, o artifactRoot pelo
 * realpath e todo hard-block existente no cwd. Varredura recursiva sem descer
 * em symlink nem em diretório já mascarado; teto/readdir falho = recusa fail-closed.
 */
function collectMaskTargets(ctx: DockerSandboxContext, env: NodeJS.ProcessEnv): MaskTarget[] {
  const cwd = resolve(ctx.cwd);
  const astroHome = resolveAstroHome(env);
  const artifactRoot = resolveArtifactRoot(env);
  // Classificador e prefiltro montados UMA vez; só symlink/candidato léxico vai ao classify.
  const classify = createPathClassifier({
    cwd,
    astroHome,
    artifactRoot,
    protectedPaths: ctx.protectedPaths,
    allowCritical: ctx.allowCritical ?? [],
  });
  const isCandidate = createLexicalHardBlockPrefilter({ cwd, astroHome, protectedPaths: ctx.protectedPaths });
  const targets = new Map<string, MaskTarget>();
  const add = (path: string): void => {
    const target = maskTargetOf(path);
    if (target !== null) targets.set(target.target, target);
  };

  add(join(cwd, ".git"));
  if (artifactRoot !== null) add(realpathPreservingDots(artifactRoot, cwd));

  let entries = 0;
  const pending: string[] = [cwd];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let names: Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      throw new ToolError("sandbox: falha ao varrer o diretório de trabalho para máscaras de hard-block");
    }
    for (const entry of names) {
      entries += 1;
      if (entries > MASK_MAX_ENTRIES) {
        throw new ToolError(`sandbox: varredura de máscaras excedeu o teto de ${MASK_MAX_ENTRIES} entradas`);
      }
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink() || isCandidate(full)) {
        if (classifyForMask(classify, full)) {
          add(full);
          continue;
        }
      }
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        pending.push(full);
      }
    }
  }
  return [...targets.values()];
}

/** Raízes temporárias das máscaras, por argv; removidas por `releaseDockerArgv`. */
const maskRoots = new WeakMap<string[], string>();

/** Remove as fontes temporárias de máscara criadas por `dockerArgv` (idempotente, best-effort). */
export function releaseDockerArgv(argv: readonly string[]): void {
  const root = maskRoots.get(argv as string[]);
  if (root === undefined) return;
  maskRoots.delete(argv as string[]);
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Fontes vazias das máscaras em `os.tmpdir()`, montadas `:ro` no mesmo caminho no container. */
function maskMounts(ctx: DockerSandboxContext, env: NodeJS.ProcessEnv): { mounts: string[]; maskRoot?: string } {
  const targets = collectMaskTargets(ctx, env);
  if (targets.length === 0) return { mounts: [] };
  const maskRoot = mkdtempSync(join(tmpdir(), "astro-sandbox-mask-"));
  try { chmodSync(maskRoot, 0o700); } catch { /* best-effort: 0700 no POSIX, bits ignorados no Windows */ }
  try {
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
    return { mounts, maskRoot };
  } catch (error) {
    // Falha ao montar o plano não pode deixar lixo em tmpdir (fail-closed).
    try { rmSync(maskRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

/**
 * Base do `docker run` isolado (ADR-0027, I-11): rede off, rootfs read-only,
 * `/tmp` tmpfs, cwd rw, git neutralizado e máscaras `:ro` dos hard-blocks.
 * `cmd` é o programa executado no container, item a item (sem shell).
 */
function dockerArgvWith(containerName: string, ctx: DockerSandboxContext, cmd: readonly string[]): string[] {
  const workdir = resolve(ctx.cwd);
  const env = ctx.env ?? process.env;
  const { mounts, maskRoot } = maskMounts(ctx, env);
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
    "/tmp:rw,noexec,nosuid,size=64m",
    "--env",
    "GIT_DIR=/dev/null",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    "--env",
    "HOME=/tmp",
    "--volume",
    `${workdir}:${workdir}`,
    ...mounts,
    "--workdir",
    workdir,
    resolveDockerImage(env),
    ...cmd,
  ];
  if (maskRoot !== undefined) maskRoots.set(argv, maskRoot);
  return argv;
}

/**
 * Argv do sandbox do `run_command`: o comando do modelo é uma string, então o
 * shell é parte desse contrato (`sh -c`).
 */
export function dockerArgv(containerName: string, ctx: DockerSandboxContext, command: string): string[] {
  return dockerArgvWith(containerName, ctx, ["sh", "-c", command]);
}

/**
 * Argv do sandbox SEM shell (F-15, #538): cada item é um argumento literal do
 * programa — `;`, `|`, `$` e espaço não têm significado. Usado por `run_tests`,
 * cujo argv vem da config (nunca do modelo).
 */
export function dockerArgvNoShell(containerName: string, ctx: DockerSandboxContext, command: readonly string[]): string[] {
  return dockerArgvWith(containerName, ctx, command);
}

/** Executa um comando dentro do container Docker efêmero e libera as máscaras. */
async function runInDocker(command: string, ctx: { cwd: string; signal?: AbortSignal }, timeoutMs: number): Promise<ToolResult> {
  const containerName = `astro-sb-${randomUUID().slice(0, 12)}`;
  const argv = dockerArgv(containerName, ctx, command);
  try {
    return await runDockerProcess(containerName, argv, ctx, timeoutMs);
  } finally {
    releaseDockerArgv(argv);
  }
}

/** Como o processo do container terminou: código, timeout do harness ou cancelamento. */
type DockerExit = { kind: "exit"; code: number } | { kind: "timeout" } | { kind: "cancelled" };

/** Resultado cru do container: saída combinada, ainda sem redação nem cap. */
interface DockerOutcome {
  exit: DockerExit;
  output: string;
}

/** stdout + stderr combinados, com trim nas pontas e sem redação (o caller redige). */
async function combinedOutput(proc: { stdout: ReadableStream<Uint8Array> | number; stderr: ReadableStream<Uint8Array> | number }): Promise<string> {
  const streamText = async (stream: ReadableStream<Uint8Array> | number): Promise<string> =>
    typeof stream === "number" ? "" : new Response(stream).text();
  const [stdout, stderr] = await Promise.all([streamText(proc.stdout), streamText(proc.stderr)]);
  return [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
}

/** Roda o argv já montado e devolve saída crua + como terminou; limpeza é do chamador. */
async function runDockerOutcome(
  containerName: string,
  argv: string[],
  ctx: { cwd: string; signal?: AbortSignal },
  timeoutMs: number,
): Promise<DockerOutcome> {
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
    return { exit: { kind: "cancelled" }, output: "" };
  }

  if (exited === timedOut) {
    // docker run morto não para o container: limpeza forçada best-effort
    removeContainer();
    return { exit: { kind: "timeout" }, output: await combinedOutput(proc) };
  }

  return { exit: { kind: "exit", code: exited }, output: await combinedOutput(proc) };
}

/** Formata o resultado do sandbox para o `run_command` (texto + nota de erro). */
async function runDockerProcess(
  containerName: string,
  argv: string[],
  ctx: { cwd: string; signal?: AbortSignal },
  timeoutMs: number,
): Promise<ToolResult> {
  const { exit, output } = await runDockerOutcome(containerName, argv, ctx, timeoutMs);

  if (exit.kind === "cancelled") {
    return { output: "comando cancelado no sandbox", isError: true };
  }

  if (exit.kind === "timeout") {
    const note = `timeout de ${timeoutMs}ms excedido no sandbox; container interrompido`;
    return { output: redactThenTruncate(output.length > 0 ? `${output}\n${note}` : note), isError: true };
  }
  if (exit.code !== 0) {
    const note = `comando terminou com código ${exit.code} (sandbox docker)`;
    return { output: redactThenTruncate(output.length > 0 ? `${output}\n${note}` : note), isError: true };
  }
  return { output: redactThenTruncate(output) };
}

// --- Shell no host (#474, opt-in via `sandbox: "auto"`) ---

/**
 * Auditoria da decisão do host (#474): só decisão/motivo/modo/shell. O comando
 * e a saída NUNCA entram no audit (I-03; a saída já volta redigida ao modelo).
 */
function auditHostDecision(
  ctx: ToolContext,
  decision: "allow" | "deny",
  extra: { reason?: string; shell?: string } = {},
): void {
  ctx.executor?.audit.append({
    run: ctx.run,
    agent: ctx.agent,
    tipo: "host_shell.decision",
    payload: {
      decision,
      permissionMode,
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ...(extra.shell === undefined ? {} : { shell: extra.shell }),
    },
  });
}

function failureCode(message: string, code: string): ToolResult {
  return { output: redactSecrets(message), isError: true, code };
}

/**
 * Executa no host (#474) depois de: allowlist/ceiling (executor), gate de
 * permissão com o comando no prompt (executor) e hard-block de path (executor).
 * Piso próprio: em `bypass` exige confirmação explícita; env sanitizado;
 * saída redigida antes do truncamento. O que se perde em relação ao Docker está
 * no ADR-0031: rede do host, FS do host e processos já em execução.
 */
async function runOnHost(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const env = ctx.env ?? process.env;
  // Sem executor não houve allowlist/gate: o host só existe atrás do gate (#474).
  if (ctx.executor === undefined) {
    return failureCode(
      "host_shell_requires_gate: shell no host só executa via ToolExecutor (allowlist e aprovação por comando)",
      "host_shell_requires_gate",
    );
  }
  // `bypass` não abre prompt: sem a confirmação explícita o host recusa (fail-closed).
  if (permissionMode === "bypass" && env[HOST_SHELL_BYPASS_CONFIRMATION_ENV] !== "1") {
    auditHostDecision(ctx, "deny", { reason: "bypass_confirmation_required" });
    return failureCode(
      `host_shell_confirmation_required: em modo bypass o shell no host exige confirmação explícita ` +
        `(${HOST_SHELL_BYPASS_CONFIRMATION_ENV}=1); use o Docker ou o modo ask`,
      "host_shell_confirmation_required",
    );
  }

  const selection = selectHostShell(detectHostShells(), preferredShell);
  if (selection.kind === "error") {
    auditHostDecision(ctx, "deny", { reason: selection.code });
    return failureCode(selection.message, selection.code);
  }
  auditHostDecision(ctx, "allow", { shell: selection.shell });

  const argv = hostShellArgv(selection.shell, command);
  const proc = Bun.spawn({
    cmd: argv,
    cwd: ctx.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: sanitizedEnv(env, ctx.secretEnvNames ?? []),
    // Sempre grupo próprio no POSIX: o timeout/cancelamento mata a árvore, não só o shell.
    detached: process.platform !== "win32",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  const aborted = Symbol("aborted");
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => {
      killProcessTree(proc);
      resolve(timedOut);
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

  if (exited === aborted) return { output: "comando cancelado no shell do host", isError: true };
  if (exited === timedOut) {
    const note = `timeout de ${timeoutMs}ms excedido no shell do host; processo interrompido`;
    const output = await combinedOutput(proc);
    return { output: redactThenTruncate(output.length > 0 ? `${output}\n${note}` : note), isError: true };
  }
  const output = await combinedOutput(proc);
  if (exited !== 0) {
    const note = `comando terminou com código ${exited} (shell do host: ${selection.shell})`;
    return { output: redactThenTruncate(output.length > 0 ? `${output}\n${note}` : note), isError: true };
  }
  return { output: redactThenTruncate(output) };
}

/** Executa um comando de shell no diretório de trabalho, com timeout do manifesto. */
export const runCommandTool: Tool = {
  manifest: {
    name: "run_command",
    description:
      "Executa um comando de shell no diretório de trabalho e devolve a saída. " +
      "No default (auto) usa o container Docker efêmero quando disponível e, sem Docker, " +
      "roda no host com aprovação por comando; tools.run_command.sandbox: true força Docker " +
      "(recomendado para repositório não confiável). Com sandbox:false recusa (sandbox_required_for_shell).",
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

    // Slice 4b (I-19): `sandbox: false` NÃO executa no host - recusa sem spawnar e sem ecoar o comando.
    if (commandMode === "disabled") {
      const error = new SandboxRequiredForShellError("sandbox:false");
      return { ...failure(error.message), code: error.code };
    }

    // `auto` é o default (#474): Docker quando disponível; sem Docker, host com
    // aprovação por comando (o gate já rodou: allowlist, prompt e hard-block).
    if (commandMode === "auto" && !(await detectDockerAvailable())) {
      return runOnHost(command, ctx, runCommandTool.manifest.timeoutMs);
    }

    // Sandbox: container Docker efêmero; sem Docker disponível, recusa (sem downgrade)
    const docker = await detectDockerAvailable();
    if (!docker) {
      return failure(
        "sandbox ativo (tools.run_command.sandbox) mas Docker não está disponível; instale e inicie o Docker",
      );
    }
    try {
      return await runInDocker(command, ctx, runCommandTool.manifest.timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`erro no sandbox docker: ${message}`);
    }
  },
};

// --- run_tests (F-15, #538) ---

/** Default do teto de execução de `run.tests.timeoutMs` (F-15, #538). */
export const DEFAULT_RUN_TESTS_TIMEOUT_MS = 120_000;

/**
 * Teto de `run.tests.timeoutMs` (1h). Acima disso o valor deixa de ser um teto
 * útil e alguns motores de timer saturam: `setTimeout(3e9)` dispara em ~1ms e
 * todo run falharia por timeout.
 */
export const MAX_RUN_TESTS_TIMEOUT_MS = 3_600_000;

/** Seção `run.tests` (F-15, #538): comando de teste do projeto, sempre argv. */
export interface RunTestsConfig {
  /** Executável + argumentos, um item por argumento: nunca uma string de shell. */
  command: readonly string[];
  /** Teto de execução em ms; default `DEFAULT_RUN_TESTS_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Código estável do comando de teste ausente (F-15, #538): não há auto-detecção. */
export const TESTS_NOT_CONFIGURED = "tests_not_configured";
/** Código estável de entrada inválida na tool (D-18). */
export const TESTS_INVALID_INPUT = "invalid_input";
/** Teto do `filter`: é um pattern, nunca uma lista de flags do modelo. */
export const MAX_TEST_FILTER_LENGTH = 200;
/** Folga do timeout da tool sobre o do comando: quem formata o timeout é o sandbox. */
const TOOL_TIMEOUT_GRACE_MS = 5_000;

export interface RunTestsDeps {
  /** Seção `run.tests` da config; ausente = `tests_not_configured`. */
  config?: RunTestsConfig;
  audit: AuditLike;
}

/**
 * Input de `run_tests` (F-15, #538): só `filter`. O comando vem da config, então
 * campo a mais é recusado — o modelo não escolhe binário, argumento nem flag.
 * Caractere de controle é recusado no valor CRU: `trim()` esconderia `\n`/`\0`
 * nas pontas e o item chegaria ao argv do programa.
 */
function testsFilter(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolError("entrada inválida: esperado objeto com { filter? }");
  }
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "filter")) {
    throw new ToolError('entrada inválida: campo desconhecido (o comando vem de "run.tests.command", nunca do modelo)');
  }
  if (raw.filter === undefined) return undefined;
  if (typeof raw.filter !== "string") throw new ToolError('entrada inválida: "filter" deve ser uma string');
  if (/[\u0000-\u001f\u007f]/.test(raw.filter)) {
    throw new ToolError('entrada inválida: "filter" contém caractere de controle');
  }
  const filter = raw.filter.trim();
  if (filter.length === 0) throw new ToolError('entrada inválida: "filter" não pode ser vazio');
  if (filter.startsWith("-")) {
    throw new ToolError('entrada inválida: "filter" não pode começar com "-" (flag não vem do modelo)');
  }
  if (filter.length > MAX_TEST_FILTER_LENGTH) {
    throw new ToolError(`entrada inválida: "filter" excede ${MAX_TEST_FILTER_LENGTH} caracteres`);
  }
  return filter;
}

/** Resultado estruturado de `run_tests` (JSON compacto devolvido ao modelo). */
export interface RunTestsResult {
  command: readonly string[];
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  output: string;
}

/**
 * Redige ANTES de cortar (ADR-0027) e escolhe a ponta: sucesso fica com a
 * cabeça, falha fica com a cauda (onde mora o relatório dos testes).
 */
function capTestsOutput(text: string, keep: "head" | "tail"): { output: string; truncated: boolean } {
  const redacted = redactSecrets(text);
  if (redacted.length <= MAX_OUTPUT) return { output: redacted, truncated: false };
  return {
    output: keep === "head" ? redacted.slice(0, MAX_OUTPUT) : redacted.slice(redacted.length - MAX_OUTPUT),
    truncated: true,
  };
}

/** Tamanho do texto já escapado dentro de um JSON (`\n` e `\u0001` contam mais). */
function jsonEscapedLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/**
 * Corta o texto por code point até o JSON escapar dentro do orçamento. Caractere
 * de controle escapa para 2–6 caracteres, então um cap em code units deixaria o
 * envelope passar do teto (e cortar a string serializada daria JSON inválido).
 */
function fitEscapedBudget(text: string, keep: "head" | "tail", budget: number): string {
  if (jsonEscapedLength(text) <= budget) return text;
  const points = Array.from(text);
  let fits = 0;
  let fails = points.length;
  while (fits < fails) {
    const middle = Math.ceil((fits + fails) / 2);
    const slice = keep === "head" ? points.slice(0, middle) : points.slice(points.length - middle);
    if (jsonEscapedLength(slice.join("")) <= budget) fits = middle;
    else fails = middle - 1;
  }
  return keep === "head" ? points.slice(0, fits).join("") : points.slice(points.length - fits).join("");
}

/**
 * Serializa o resultado dentro de `MAX_OUTPUT`: o teto vale para o JSON inteiro
 * que o modelo recebe, não só para `output`. Se precisar cortar mais, mantém a
 * mesma ponta do cap (cabeça no sucesso, cauda na falha) e marca `truncated`.
 */
function serializeTestsResult(
  result: RunTestsResult,
  keep: "head" | "tail",
): { json: string; truncated: boolean } {
  const direct = JSON.stringify(result);
  if (direct.length <= MAX_OUTPUT) return { json: direct, truncated: result.truncated };
  const skeleton = JSON.stringify({ ...result, truncated: true, output: "" });
  const budget = Math.max(0, MAX_OUTPUT - skeleton.length);
  const output = fitEscapedBudget(result.output, keep, budget);
  return { json: JSON.stringify({ ...result, truncated: true, output }), truncated: true };
}

/**
 * Tool `run_tests` (F-15, #538): executa o comando de teste DO PROJETO pelo
 * mesmo sandbox do `run_command`, com a mesma recusa sem sandbox (I-19). O argv
 * vem de `run.tests.command` e vai item a item para o container — sem shell,
 * sem interpolação e sem flag escolhida pelo modelo. `filter`, quando presente,
 * é um único argumento extra.
 */
export function createRunTestsTool(deps: RunTestsDeps): Tool {
  // Teto duro mesmo se a tool for criada sem passar pelo `validateConfig`.
  const timeoutMs = Math.min(deps.config?.timeoutMs ?? DEFAULT_RUN_TESTS_TIMEOUT_MS, MAX_RUN_TESTS_TIMEOUT_MS);

  /** Comando que o prompt de aprovação mostra: o da config, com o filter se válido. */
  const materialCommand = (input: unknown): ApprovalDetail | undefined => {
    const command = deps.config?.command;
    if (command === undefined || command.length === 0) return undefined;
    let filter: string | undefined;
    // Input inválido não pode derrubar o prompt: o comando da config já informa a decisão.
    try {
      filter = testsFilter(input);
    } catch {
      filter = undefined;
    }
    const argv = filter === undefined ? [...command] : [...command, filter];
    return { kind: "command", value: redactSecrets(argv.join(" ")) };
  };

  return {
    manifest: {
      name: "run_tests",
      description:
        "Executa o comando de teste do projeto (run.tests.command, argv) no mesmo sandbox Docker do run_command, " +
        "sem shell: `filter` vira um único argumento extra. Sem run.tests.command devolve tests_not_configured.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            maxLength: MAX_TEST_FILTER_LENGTH,
            description:
              'Pattern passado como um único argumento ao comando (ex.: caminho de um teste). Sem caractere de controle e não pode começar com "-".',
          },
        },
        additionalProperties: false,
      },
      risk: "high",
      permission: "execute",
      class: "shell",
      timeoutMs: timeoutMs + TOOL_TIMEOUT_GRACE_MS,
      retryable: false,
      idempotent: false,
      sideEffects: "process",
    },

    // #578: o comando executado vem da config, não do input — sem isto o prompt
    // pediria aprovação de shell sem mostrar o que roda (cwd é rw no sandbox).
    approvalDetail: materialCommand,

    async execute(input, ctx: ToolContext): Promise<ToolResult> {
      let filter: string | undefined;
      try {
        filter = testsFilter(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { output: redactSecrets(message), isError: true, code: TESTS_INVALID_INPUT };
      }

      const command = deps.config?.command ?? [];
      if (command.length === 0) {
        return {
          output:
            `run_tests: comando de teste do projeto não configurado (${TESTS_NOT_CONFIGURED}); ` +
            'defina "run.tests.command" no astro.config.json como argv, ex.: "run": { "tests": { "command": ["bun", "test"] } }',
          isError: true,
          code: TESTS_NOT_CONFIGURED,
        };
      }

      // `run_tests` mantém a regra própria (#474): exige Docker explícito, mesmo
      // com `auto` no default - o argv vem da config e roda isolado.
      if (commandMode !== "docker") {
        const mode = commandMode === "auto"
          ? "sandbox:auto (run_tests exige Docker)"
          : "sandbox:false";
        const error = new SandboxRequiredForShellError(mode, "run_tests");
        return { ...failure(error.message), code: error.code };
      }
      if (!(await detectDockerAvailable())) {
        return failure(
          "sandbox ativo (tools.run_command.sandbox) mas Docker não está disponível; instale e inicie o Docker",
        );
      }

      const argv = filter === undefined ? [...command] : [...command, filter];
      const containerName = `astro-sb-${randomUUID().slice(0, 12)}`;
      const startedAt = Date.now();
      let docker: string[] | undefined;
      let outcome: DockerOutcome;
      try {
        docker = dockerArgvNoShell(containerName, ctx, argv);
        outcome = await runDockerOutcome(containerName, docker, ctx, timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`erro no sandbox docker: ${message}`);
      } finally {
        if (docker !== undefined) releaseDockerArgv(docker);
      }

      const durationMs = Date.now() - startedAt;
      const failed = outcome.exit.kind !== "exit" || outcome.exit.code !== 0;
      const keep = failed ? "tail" : "head";
      const capped = capTestsOutput(outcome.output, keep);
      const exitCode = outcome.exit.kind === "exit" ? outcome.exit.code : null;
      const result: RunTestsResult = {
        // Mesma redação do audit: o argv vem da config e pode carregar segredo (I-03).
        command: argv.map((item) => redactSecrets(item)),
        exitCode,
        durationMs,
        truncated: capped.truncated,
        ...(outcome.exit.kind === "timeout" ? { timedOut: true } : {}),
        ...(outcome.exit.kind === "cancelled" ? { cancelled: true } : {}),
        output: capped.output,
      };
      const serialized = serializeTestsResult(result, keep);

      // Audit só com o comando e o código: a saída dos testes nunca vai para o log (I-03).
      deps.audit.append({
        run: ctx.run,
        agent: ctx.agent,
        tipo: "tests.result",
        payload: {
          command: redactSecrets(argv.join(" ")),
          exitCode,
          durationMs,
          truncated: serialized.truncated,
          isError: failed,
        },
      });

      return failed
        ? { output: serialized.json, isError: true }
        : { output: serialized.json };
    },
  };
}
