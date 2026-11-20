/**
 * Smoke do pacote empacotado (#542): `bun run build`, `npm pack`, instalação
 * limpa do tarball e, no diretório instalado, `astro --version`, `--help`,
 * `doctor` e um boot real da TUI contra um provider OpenAI-compatible em
 * loopback (mock local + chave falsa via `credentialRef`).
 *
 * Complementa `bun run smoke` (launcher no repo) e `bun run release:check`
 * (gate): cobre o que só aparece depois de instalar o pacote. Não publica
 * nada, nunca usa credencial real, nunca fala com a rede fora de 127.0.0.1
 * durante a TUI e limpa tarball e temporários. Única etapa com rede é o
 * `npm install` do tarball, que baixa `ink`/`react`/`bun` do registry como o
 * §4 de `docs/release.md`; dentro da árvore só `dist/` é reescrito (build).
 *
 * Uso: bun scripts/packed-smoke.ts [--json]
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { redactSecrets } from "../src/sanitize-external";
import {
  installedAstroBin,
  readPackageMeta,
  stepEnv,
  tarballFileName,
  tailForFailure,
} from "./release-check";

export const SMOKE_PROVIDER = "mock";
export const SMOKE_MODEL = "mock-model";
export const SMOKE_PROMPT = "smoke: responda ok";
/** Nome da env com a chave falsa: o provider guarda só o ref (`I-03`). */
export const SMOKE_KEY_ENV = "ASTRO_PACKED_SMOKE_KEY";
export const SMOKE_KEY_VALUE = "loopback-dummy-key";

const FIRST_FRAME_MS = 30_000;
const TURN_MS = 45_000;
const EXIT_MS = 15_000;
const STEP_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 50;
/** Prefixo próprio: o temporário não se confunde com o do `release:check`. */
const TEMP_PREFIX = "astro-packed-smoke-";
/** Mensagem do `runTui` quando o processo não tem terminal. */
const NEEDS_TTY = /precisa de um terminal interativo/i;

/** Launcher do pacote é Node; ele resolve o Bun empacotado. */
function nodeBinary(): string {
  const node = Bun.which("node");
  if (node === null) throw new SmokeError("node não encontrado no PATH; o launcher do pacote roda em Node");
  return node;
}

function npmBinary(): string {
  const npm = Bun.which("npm");
  if (npm === null) throw new SmokeError("npm não encontrado no PATH");
  return npm;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), TEMP_PREFIX));
}

/** Remove só diretório criado por este script (prefixo e pai `tmpdir()`). */
function removeTempDir(dir: string): void {
  const absolute = resolve(dir);
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith(TEMP_PREFIX)) {
    throw new Error(`recusando remover diretório temporário fora do padrão: ${dir}`);
  }
  rmSync(absolute, { recursive: true, force: true });
}

export interface CliOptions {
  json: boolean;
  help: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

export type StepStatus = "passed" | "skipped" | "failed" | "not-run";

export interface StepResult {
  id: string;
  status: StepStatus;
  detail: string;
}

export class SmokeError extends Error {
  override name = "SmokeError";
}

const USAGE = `Uso: bun scripts/packed-smoke.ts [--json]

Empacota e instala o tarball local, exercita a CLI instalada e abre a TUI com
um provider mock em loopback. Não publica nada e não usa credencial real.
  --json  imprime só o resumo JSON ao final
  --help  mostra esta ajuda

O wizard de provider e a navegação (/providers, /log, /model) seguem
manuais: docs/release.md §5.`;

/** Config do projeto temporário: provider local sem chave real, modelo fixo. */
export function smokeConfig(port: number): Record<string, unknown> {
  return {
    providers: {
      [SMOKE_PROVIDER]: {
        kind: "openai-compat",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        credentialRef: SMOKE_KEY_ENV,
      },
    },
    models: [{ provider: SMOKE_PROVIDER, id: SMOKE_MODEL, tags: ["writing-code"], context: 8192 }],
    agent: { model: `${SMOKE_PROVIDER}/${SMOKE_MODEL}`, maxSteps: 4, tools: [] },
  };
}

/** `$ASTRO_HOME/state.json`: o diretório do smoke já confiável (sem prompt). */
export function trustState(folder: string): Record<string, unknown> {
  return { version: 1, trust: { folders: [folder] }, migrations: { providers: true, trust: true } };
}

/** Primeira linha do header (`ASTRO v<versão> · provider/modelo · saúde`). */
export function firstFrame(output: string, version: string): string | undefined {
  const plain = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  return plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes(`ASTRO v${version}`) && line.includes(`${SMOKE_PROVIDER}/${SMOKE_MODEL}`));
}

/**
 * Confere que o mock recebeu exatamente a requisição esperada: uma única
 * chamada de chat, com o modelo, o prompt e a credencial do provider.
 * Devolve o motivo em português ou `undefined` quando está tudo certo.
 */
export function completionProblem(
  requests: readonly RecordedRequest[],
  expect: { model: string; prompt: string; key: string },
): string | undefined {
  if (requests.length !== 1) return `mock recebeu ${requests.length} requisição(ões); esperava 1`;
  const request = requests[0]!;
  if (request.method !== "POST" || !request.path.endsWith("/chat/completions")) {
    return `mock recebeu ${request.method} ${request.path}; esperava POST .../chat/completions`;
  }
  if (request.authorization !== `Bearer ${expect.key}`) {
    return "Authorization do provider não chegou ao mock (credencial ausente ou diferente)";
  }
  let body: unknown;
  try {
    body = JSON.parse(request.body);
  } catch {
    return "corpo da requisição não é JSON";
  }
  const parsed = body as { model?: unknown; messages?: unknown };
  if (parsed.model !== expect.model) {
    return `modelo divergente no corpo: esperava "${expect.model}"`;
  }
  if (!Array.isArray(parsed.messages)) return "corpo sem lista de mensagens";
  const users = (parsed.messages as Array<{ role?: unknown; content?: unknown }>)
    .filter((message) => message.role === "user");
  if (users.length !== 1) return `esperava 1 mensagem de usuário; recebeu ${users.length}`;
  if (users[0]!.content !== expect.prompt) return "prompt enviado ao mock difere do digitado na TUI";
  return undefined;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`argumento desconhecido: ${arg}`);
  }
  return options;
}

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

function run(cmd: string[], cwd: string, env: Record<string, string>, timeout: number): RunResult {
  const proc = Bun.spawnSync({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
  return {
    code: proc.exitCode ?? null,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

function outputOf(result: RunResult): string {
  return tailForFailure(`${result.out}\n${result.err}`);
}

/** Ambiente sem segredos do host; o smoke só acrescenta as variáveis dele. */
function smokeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...stepEnv(process.env), ...extra };
}

interface MockServer {
  port: number;
  requests: RecordedRequest[];
  stop: () => void;
}

/** Mock OpenAI-compatible: grava cada requisição e responde um turno fixo. */
function startMock(): MockServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.text() : "";
      const authorizationHeader = request.headers.get("authorization");
      requests.push({
        method: request.method,
        path,
        authorization: authorizationHeader === null ? undefined : authorizationHeader,
        body,
      });
      if (!path.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ error: { message: "mock: rota inesperada" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-packed-smoke",
        object: "chat.completion",
        created: 0,
        model: SMOKE_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  return { port: server.port ?? 0, requests, stop: () => void server.stop(true) };
}

interface TuiContext {
  projectDir: string;
  home: string;
  pkgDir: string;
  version: string;
}

interface TuiOutcome {
  status: "passed" | "skipped";
  detail: string;
}

/** Boot da TUI instalada contra o mock; falha com mensagem clara se não houver TTY nem frame. */
async function runTui(ctx: TuiContext): Promise<TuiOutcome> {
  const shim = join(resolve(import.meta.dir), "packed-smoke-tty.ts");
  const cli = join(ctx.pkgDir, "dist", "cli.js");
  const bun = join(ctx.projectDir, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  for (const file of [shim, cli, bun]) {
    if (!existsSync(file)) throw new SmokeError(`arquivo ausente no pacote instalado: ${file}`);
  }

  const mock = startMock();
  writeFileSync(join(ctx.projectDir, "astro.config.json"), `${JSON.stringify(smokeConfig(mock.port), null, 2)}\n`);
  writeFileSync(join(ctx.home, "state.json"), `${JSON.stringify(trustState(ctx.projectDir), null, 2)}\n`);

  const child = Bun.spawn({
    cmd: [bun, "--preload", shim, cli],
    cwd: ctx.projectDir,
    env: smokeEnv({
      ASTRO_HOME: ctx.home,
      // Opt-in de dev para loopback (docs/web-tools.md); vale só este processo.
      ASTRO_ALLOW_PRIVATE_URLS: "1",
      [SMOKE_KEY_ENV]: SMOKE_KEY_VALUE,
      NO_COLOR: "1",
    }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let out = "";
  let err = "";
  void (async () => { for await (const chunk of child.stdout) out += decoder.decode(chunk); })();
  void (async () => { for await (const chunk of child.stderr) err += decoder.decode(chunk); })();

  const tail = (): string => tailForFailure(`${out}\n${err}`);
  const waitUntil = async (check: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await Bun.sleep(POLL_MS);
    }
    return check();
  };
  const write = async (text: string): Promise<void> => {
    child.stdin.write(text);
    await child.stdin.flush();
  };

  try {
    const booted = await waitUntil(() => firstFrame(out, ctx.version) !== undefined, FIRST_FRAME_MS);
    const frame = firstFrame(out, ctx.version);
    if (frame === undefined) {
      if (NEEDS_TTY.test(`${out}\n${err}`)) {
        return { status: "skipped", detail: "precisa de TTY: o pacote reportou falta de terminal interativo" };
      }
      if (!booted) child.kill();
      throw new SmokeError(
        `a TUI não desenhou o primeiro frame em ${FIRST_FRAME_MS / 1000}s (exit ${child.exitCode ?? "n/a"}):\n${tail()}`,
      );
    }

    await write(SMOKE_PROMPT);
    // Enter em chunk separado: junto do texto, o turno não abre.
    await Bun.sleep(100);
    await write("\r");
    if (!await waitUntil(() => mock.requests.length > 0, TURN_MS)) {
      throw new SmokeError(`o mock não recebeu requisição em ${TURN_MS / 1000}s:\n${tail()}`);
    }
    const problem = completionProblem(mock.requests, {
      model: SMOKE_MODEL,
      prompt: SMOKE_PROMPT,
      key: SMOKE_KEY_VALUE,
    });
    if (problem !== undefined) throw new SmokeError(problem);
    // Footer só mostra turnos concluídos (#480): prova que o turno fechou.
    if (!await waitUntil(() => /1 turno\(s\)/.test(out), TURN_MS)) {
      throw new SmokeError(`o turno não fechou em ${TURN_MS / 1000}s:\n${tail()}`);
    }

    await write("\u0003");
    const exit = await Promise.race([child.exited, Bun.sleep(EXIT_MS).then(() => undefined)]);
    if (exit === undefined) {
      child.kill();
      throw new SmokeError(`a TUI não saiu em ${EXIT_MS / 1000}s após ctrl+c; processo encerrado`);
    }
    if (exit !== 0) throw new SmokeError(`a TUI saiu com código ${exit} após ctrl+c:\n${tail()}`);
    return {
      status: "passed",
      detail: `frame "${frame}" · 1 requisição no mock · exit 0`,
    };
  } finally {
    if (child.exitCode === null) child.kill();
    // Windows só libera o cwd (e o rm do temporário) depois que o filho saiu.
    await Promise.race([child.exited, Bun.sleep(EXIT_MS)]);
    mock.stop();
  }
}

interface PlanStep {
  id: string;
  label: string;
  body: () => Promise<{ status: "passed" | "skipped"; detail: string }> | { status: "passed" | "skipped"; detail: string };
}

/** Executa o plano em ordem, para na primeira falha e marca o resto como não rodado. */
async function runPlan(
  steps: readonly PlanStep[],
  emit: (line: string) => void,
): Promise<{ results: StepResult[]; failure: string | null }> {
  const results: StepResult[] = [];
  let failure: string | null = null;
  for (const [index, step] of steps.entries()) {
    if (failure !== null) {
      results.push({ id: step.id, status: "not-run", detail: "não executado após falha" });
      emit(`[${index + 1}/${steps.length}] ${step.label} ... não executado`);
      continue;
    }
    emit(`[${index + 1}/${steps.length}] ${step.label}`);
    try {
      const outcome = await step.body();
      results.push({ id: step.id, status: outcome.status, detail: outcome.detail });
      emit(`  ${outcome.status === "passed" ? "ok" : "pulado"}: ${outcome.detail}`);
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      results.push({ id: step.id, status: "failed", detail: message });
      failure = `${step.id}: ${message}`;
      emit(`  falhou: ${message}`);
    }
  }
  return { results, failure };
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`smoke:packed: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const root = resolve(import.meta.dir, "..");
  const meta = readPackageMeta(root);
  const packDir = makeTempDir();
  const projectDir = makeTempDir();
  // ASTRO_HOME fora do cwd do projeto: o doctor recusa artifact root dentro do cwd.
  const home = makeTempDir();
  writeFileSync(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: "astro-packed-smoke", private: true }, null, 2)}\n`,
  );
  const pkgDir = join(projectDir, "node_modules", ...meta.name.split("/"));
  const tarballName = tarballFileName(meta.name, meta.version);

  const emit = options.json ? () => {} : (line: string) => console.log(line);
  let tarball = "";

  const steps: PlanStep[] = [
    {
      id: "build",
      label: "build do repo",
      body: () => {
        const result = run([process.execPath, "run", "build"], root, smokeEnv(), STEP_TIMEOUT_MS);
        if (result.code !== 0) throw new SmokeError(`bun run build falhou (exit ${result.code}):\n${outputOf(result)}`);
        return { status: "passed", detail: "dist/cli.js e dist/launcher.js" };
      },
    },
    {
      id: "pack",
      label: "npm pack",
      body: () => {
        const npm = npmBinary();
        const result = run([npm, "pack", "--pack-destination", packDir], root, smokeEnv(), STEP_TIMEOUT_MS);
        if (result.code !== 0) throw new SmokeError(`npm pack falhou (exit ${result.code}):\n${outputOf(result)}`);
        const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
        if (tarballs.length !== 1 || tarballs[0] !== tarballName) {
          throw new SmokeError(`npm pack: esperava ${tarballName}; encontrei ${tarballs.join(", ") || "nada"}`);
        }
        tarball = join(packDir, tarballName);
        return { status: "passed", detail: tarballName };
      },
    },
    {
      id: "install",
      label: "instalação limpa do tarball",
      body: () => {
        const npm = npmBinary();
        const result = run(
          [npm, "install", "--no-audit", "--no-fund", tarball],
          projectDir,
          smokeEnv(),
          STEP_TIMEOUT_MS,
        );
        if (result.code !== 0) throw new SmokeError(`npm install falhou (exit ${result.code}):\n${outputOf(result)}`);
        const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name !== meta.name || manifest.version !== meta.version) {
          throw new SmokeError(`pacote instalado diverge do repo: ${String(manifest.name)}@${String(manifest.version)}`);
        }
        if (!existsSync(installedAstroBin(projectDir))) {
          throw new SmokeError("npm install não criou node_modules/.bin/astro");
        }
        return { status: "passed", detail: `${meta.name}@${meta.version}` };
      },
    },
    {
      id: "version",
      label: "astro --version no pacote instalado",
      body: () => {
        const node = nodeBinary();
        const result = run([node, join(pkgDir, "dist", "launcher.js"), "--version"], projectDir, smokeEnv(), STEP_TIMEOUT_MS);
        const expected = `astro ${meta.version}`;
        if (result.code !== 0 || result.out.trim() !== expected) {
          throw new SmokeError(`esperava "${expected}" (exit 0); veio exit ${result.code}:\n${outputOf(result)}`);
        }
        return { status: "passed", detail: expected };
      },
    },
    {
      id: "help",
      label: "astro --help no pacote instalado",
      body: () => {
        const node = nodeBinary();
        const result = run([node, join(pkgDir, "dist", "launcher.js"), "--help"], projectDir, smokeEnv(), STEP_TIMEOUT_MS);
        for (const command of ["astro run", "astro chat"]) {
          if (result.code !== 0 || !result.out.includes(command)) {
            throw new SmokeError(`--help sem "${command}" (exit ${result.code}):\n${outputOf(result)}`);
          }
        }
        return { status: "passed", detail: "astro run, astro chat" };
      },
    },
    {
      id: "doctor",
      label: "astro doctor com ASTRO_HOME isolado",
      body: () => {
        const node = nodeBinary();
        const result = run(
          [node, join(pkgDir, "dist", "launcher.js"), "doctor"],
          projectDir,
          smokeEnv({ ASTRO_HOME: home }),
          STEP_TIMEOUT_MS,
        );
        if (result.code !== 0 || !result.out.includes("0 fail")) {
          throw new SmokeError(`doctor com falha (exit ${result.code}):\n${outputOf(result)}`);
        }
        return { status: "passed", detail: "0 fail, home temporário" };
      },
    },
    {
      id: "tui",
      label: "TUI instalada com provider mock em loopback",
      body: () => runTui({ projectDir, home, pkgDir, version: meta.version }),
    },
  ];

  if (!options.json) {
    console.log(`smoke:packed: ${meta.name}@${meta.version}`);
    console.log(`smoke:packed: temporário ${projectDir}`);
  }

  const { results, failure: planFailure } = await runPlan(steps, emit);
  let failure = planFailure;
  const skipped = results.filter((result) => result.status === "skipped").length;

  try {
    for (const dir of [projectDir, home, packDir]) removeTempDir(dir);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (failure === null) failure = `cleanup: ${message}`;
    else emit(`  aviso: falha ao limpar temporários: ${message}`);
  }

  if (options.json) {
    console.log(JSON.stringify({
      ok: failure === null,
      packageName: meta.name,
      version: meta.version,
      steps: results,
      failure,
    }, null, 2));
  } else if (failure === null) {
    console.log(`smoke:packed ok (${results.length} etapas, ${skipped} pulada(s))`);
  } else {
    console.error(`smoke:packed falhou: ${failure}`);
  }
  return failure === null ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
