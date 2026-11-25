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
 * O boot da TUI é o ponto do #542: etapa obrigatória, sem tolerância. O preload
 * `packed-smoke-tty.ts` falsifica `isTTY` em toda plataforma, então a mensagem
 * "precisa de um terminal" só aparece quando o preload NÃO rodou — exatamente
 * quando o gate tem de falhar. A TUI também prova `/providers` (health `ok` com
 * latência) e `/log` (header com endpoint + linha de turno), as duas provas do
 * critério de aceite do #542.
 *
 * Uso: bun scripts/packed-smoke.ts [--json]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { saveHomeState, type AstroHomeState } from "../src/home-state";
import { resolveBun } from "../src/launcher";
import { redactSecrets } from "../src/sanitize-external";
import { canonicalFolder } from "../src/trust";
import { TERMS_VERSION } from "../src/terms";
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
/** Etapa que prova o boot da TUI: sem ela o resumo não sai `ok`. */
export const TUI_STEP_ID = "tui";

const FIRST_FRAME_MS = 30_000;
const TURN_MS = 45_000;
/** Telas da TUI (`/providers`, `/log`) respondem em memória: folga curta. */
const SCREEN_MS = 15_000;
const EXIT_MS = 15_000;
const STEP_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 50;
const REMOVE_ATTEMPTS = 6;
const REMOVE_DELAY_MS = 150;
/** Carência do kill normal antes do SIGKILL: o filho tem 2 s para sair sozinho. */
const KILL_GRACE_MS = 2_000;
/** Prefixo próprio: o temporário não se confunde com o do `release:check`. */
const TEMP_PREFIX = "astro-packed-smoke-";
/** Mensagem do `runTui` quando o processo não tem terminal. */
const NEEDS_TTY = /precisa de um terminal interativo/i;

export class SmokeError extends Error {
  override name = "SmokeError";
}

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

/** Raiz temporária e os três subdiretórios: uma remoção cobre tudo. */
export interface SmokeDirs {
  root: string;
  packDir: string;
  projectDir: string;
  home: string;
}

/** Layout puro: nenhum subdiretório fica fora da raiz que o `finally` remove. */
export function smokeDirs(root: string): SmokeDirs {
  return {
    root,
    packDir: join(root, "pack"),
    projectDir: join(root, "project"),
    home: join(root, "home"),
  };
}

/**
 * Um `mkdtemp` só: se um `mkdir` falhar, a raiz já criada é removida aqui —
 * não existe diretório órfão entre a criação e a instalação do handler.
 */
export function createSmokeDirs(): SmokeDirs {
  const dirs = smokeDirs(makeTempDir());
  try {
    for (const dir of [dirs.packDir, dirs.projectDir, dirs.home]) mkdirSync(dir, { recursive: true });
  } catch (error) {
    rmSync(dirs.root, { recursive: true, force: true });
    throw error;
  }
  return dirs;
}

/** Remove só diretório criado por este script (prefixo e pai `tmpdir()`). */
function removeTempDir(dir: string): void {
  const absolute = resolve(dir);
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith(TEMP_PREFIX)) {
    throw new Error(`recusando remover diretório temporário fora do padrão: ${dir}`);
  }
  rmSync(absolute, { recursive: true, force: true });
}

/**
 * Windows só libera o `cwd` (e os arquivos dentro dele) um pouco depois do
 * filho sair: tenta de novo em vez de falhar o `rm` de um diretório que já era.
 */
export function removeTempDirWithRetry(dir: string, attempts = REMOVE_ATTEMPTS, delayMs = REMOVE_DELAY_MS): void {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      removeTempDir(dir);
      return;
    } catch (error) {
      last = error;
      if (attempt < attempts - 1) Bun.sleepSync(delayMs);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * `redactSecrets` casa por formato (`apiKey|token|password`…); a chave de
 * fixture do smoke não tem esse formato, então sai por identidade (`I-03`).
 */
export function redactSmokeText(text: string): string {
  return redactSecrets(text).replaceAll(SMOKE_KEY_VALUE, "[redigido]");
}

/** Últimas linhas da saída, redigidas pelo padrão e pela chave da fixture. */
function failureTail(text: string): string {
  return redactSmokeText(tailForFailure(text));
}

/** Saída da TUI sem ANSI: os frames do Ink deixam só o texto comparável. */
export function plainOutput(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/**
 * Linhas lógicas da TUI: sem ANSI, sem a borda `│ … │` dos painéis do Ink e sem
 * o padding da caixa. Assim uma linha dentro de painel compara por igualdade.
 */
export function tuiLines(text: string): string[] {
  return plainOutput(text)
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*│\s?/, "")
      .replace(/\s*│\s*$/, "")
      .trim());
}

export interface BunLookupDeps {
  /** Default: `createRequire` ancorado no `package.json` do pacote instalado. */
  resolve?: (id: string) => string;
  exists?: (path: string) => boolean;
  /** `stat` do candidato; descarta o placeholder de ~450 bytes do pacote `bun`. */
  stat?: (path: string) => { size: number };
  platform?: NodeJS.Platform;
  arch?: string;
  /** PATH do host; default nunca acha nada — o smoke prova o pacote, não a máquina. */
  which?: (name: string) => string | undefined;
}

/**
 * Bun do pacote instalado com a mesma ordem do launcher (`resolveBun`): pacote
 * de plataforma (binário real, sem postinstall) e depois `bun/bin` quando o
 * postinstall rodou. Sem `ASTRO_BUN_PATH` e sem PATH do host: com
 * `ignore-scripts=true` ou instalação parcial o erro é explícito, não um
 * `spawn` opaco dentro da TUI.
 */
export function packagedBun(pkgDir: string, deps: BunLookupDeps = {}): string {
  try {
    return resolveBun({
      env: {},
      runningUnderBun: false,
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
      resolve: deps.resolve ?? ((id: string) => createRequire(join(pkgDir, "package.json")).resolve(id)),
      exists: deps.exists ?? existsSync,
      stat: deps.stat ?? statSync,
      which: deps.which ?? (() => undefined),
    });
  } catch (error) {
    const message = redactSmokeText(error instanceof Error ? error.message : String(error));
    throw new SmokeError(`Bun do pacote instalado indisponível:\n${message}`);
  }
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

export interface StepOutcome {
  status: "passed" | "skipped";
  detail: string;
}

export const USAGE = `Uso: bun scripts/packed-smoke.ts [--json]

Empacota e instala o tarball local, exercita a CLI instalada e abre a TUI com
um provider mock em loopback. Não publica nada e não usa credencial real.
  --json            imprime só o resumo JSON ao final
  --help            mostra esta ajuda

Não há tolerância para a etapa TUI: ela é obrigatória em toda plataforma. O
preload do smoke falsifica o TTY; "precisa de um terminal" significa que o
preload não rodou e o run falha. O resumo só é "ok" com o boot da TUI.
O wizard de provider segue manual: docs/release.md §5.`;

/** Porta usável no loopback: `0`, `NaN` ou fracionária apontaria a config para `:0`. */
export function requirePort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new SmokeError(`porta do mock inválida: ${String(port)} (esperava inteiro entre 1 e 65535)`);
  }
  return port;
}

/** Config do projeto temporário: provider local sem chave real, modelo fixo. */
export function smokeConfig(input: number): Record<string, unknown> {
  const port = requirePort(input);
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

/**
 * `$ASTRO_HOME/state.json`: diretório do smoke já confiável (sem prompt) e
 * termos já aceitos na versão corrente. Sem o aceite, o portão de #479 mostra
 * a tela dos termos antes do primeiro frame e o smoke para ali.
 */
export function trustState(folder: string): AstroHomeState {
  return {
    version: 1,
    trust: { folders: [folder] },
    migrations: { providers: true, trust: true },
    terms: { version: TERMS_VERSION, acceptedAt: new Date().toISOString() },
  };
}

/**
 * Config do projeto (base URL do mock) + `$ASTRO_HOME/state.json` já confiável.
 * A pasta vai para o trust como `realpath`: `ensureTrustedCwd` compara com
 * `canonicalFolder` e, sem isso, macOS (`/var`) e o TEMP 8.3 do Windows abrem
 * o modal de trust e o prompt cai dentro dele. `saveHomeState` valida o schema
 * aqui, não 45 s depois dentro da TUI.
 */
export function prepareHome(home: string, projectDir: string, port: number): void {
  writeFileSync(join(projectDir, "astro.config.json"), `${JSON.stringify(smokeConfig(port), null, 2)}\n`);
  saveHomeState(trustState(canonicalFolder(projectDir)), join(home, "state.json"));
}

/** First status line (zone 4) after the TUI mounts: `<provider>/<model> · … · modo: …`. */
export function firstFrame(output: string): string | undefined {
  return plainOutput(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes(`${SMOKE_PROVIDER}/${SMOKE_MODEL}`) && line.includes("modo:"));
}

/**
 * Requisições de turno: só `.../chat/completions`. O health (`GET /models`)
 * usa o mesmo mock e não conta como POST do turno.
 */
export function chatRequests(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.path.endsWith("/chat/completions"));
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
  const posts = chatRequests(requests);
  if (posts.length !== 1) return `mock recebeu ${posts.length} chamada(s) de chat; esperava 1`;
  const request = posts[0]!;
  if (request.method !== "POST") {
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

/** Footer shows usage after a closed turn (#594): tokens prove the turn finished. */
export function hasClosedTurn(output: string): boolean {
  return /\d+\/\d+ tokens/.test(plainOutput(output));
}

/** `Resumo: … 0 fail` do doctor, sem aceitar `10 fail` como vizinho. */
export function doctorClean(output: string): boolean {
  return /(?:^|\D)0 fail(?!\d)/m.test(plainOutput(output));
}

/**
 * Header da tela `/log` (#514): linha própria com versão, provider/modelo e
 * endpoint. A linha da lane no buffer (`[sessão] …`) não serve: só a tela prova
 * que o `/log` abriu com o endpoint certo.
 */
export function logHeaderShown(output: string, version: string, port: number): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^ASTRO v${escaped} · ${SMOKE_PROVIDER}/${SMOKE_MODEL} · endpoint http://127\\.0\\.0\\.1:${port}/v1\\r?$`,
    "m",
  ).test(plainOutput(output));
}

/** Linha de turno do `/log` (lane `[turno]`), na linha inteira. */
export function turnLogged(output: string): boolean {
  return /^\[turno\] turno concluído\r?$/m.test(plainOutput(output));
}

/** Linha `ok` do health na tela de providers, quando existir. */
export function providerOkLine(output: string, provider = SMOKE_PROVIDER): string | undefined {
  const pattern = new RegExp(`^${provider}: ok · \\d+ms$`);
  return tuiLines(output).find((line) => pattern.test(line));
}

/** Resultado do `/providers` → `t` → enter: `mock: ok · 12ms`. */
export function providerOk(output: string, provider = SMOKE_PROVIDER): boolean {
  return providerOkLine(output, provider) !== undefined;
}

/**
 * Linha `ok` obrigatória: sem ela a etapa falha em vez de inventar "ok" no
 * detalhe do resumo. O `waitUntil` antes já provou a linha; isto fecha o furo.
 */
export function requiredProviderOkLine(output: string, provider = SMOKE_PROVIDER): string {
  const line = providerOkLine(output, provider);
  if (line === undefined) {
    throw new SmokeError(`/providers não mostrou "${provider}: ok · <latência>":\n${failureTail(output)}`);
  }
  return line;
}

/** Confirmação do `t` na tela de providers (`Testar mock?`). */
export function providerTestPrompt(output: string): boolean {
  return tuiLines(output).includes(`Testar ${SMOKE_PROVIDER}?`);
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { json: false, help: false };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--allow-skip-tui") {
      throw new Error("--allow-skip-tui foi removido: a etapa TUI é obrigatória em toda plataforma");
    } else throw new Error(`argumento desconhecido: ${arg}`);
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
  return failureTail(`${result.out}\n${result.err}`);
}

/** Ambiente sem segredos do host; o smoke só acrescenta as variáveis dele. */
function smokeEnv(extra: Record<string, string> = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...stepEnv(source), ...extra };
}

/**
 * `npm install` grava no cache do npm. Sem `NPM_CONFIG_CACHE` herdado, o cache
 * vai para dentro do temporário (removido no fim) em vez do `~/.npm` do host.
 */
export function npmInstallEnv(packDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited = source.NPM_CONFIG_CACHE ?? source.npm_config_cache;
  if (inherited !== undefined && inherited !== "") return smokeEnv({}, source);
  return smokeEnv({ NPM_CONFIG_CACHE: join(packDir, "npm-cache") }, source);
}

interface MockServer {
  port: number;
  requests: RecordedRequest[];
  stop: () => void;
}

/**
 * Mock OpenAI-compatible: grava cada requisição, responde o health
 * (`GET /v1/models`, para `/providers` → `t` resolver `ok`) e um turno fixo.
 * O health exige o mesmo Bearer do provider: sem ele o mock responde 401, então
 * a linha `ok` prova que o `credentialRef` do `astro.config.json` resolveu.
 */
export function startMock(): MockServer {
  const requests: RecordedRequest[] = [];
  let stopped = false;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.text() : "";
      const authorizationHeader = request.headers.get("authorization");
      const authorization = authorizationHeader === null ? undefined : authorizationHeader;
      requests.push({ method: request.method, path, authorization, body });
      if (request.method === "GET" && path.endsWith("/models")) {
        if (authorization !== `Bearer ${SMOKE_KEY_VALUE}`) {
          return json({ error: { message: "mock: health exige Authorization Bearer" } }, 401);
        }
        return json({ object: "list", data: [{ id: SMOKE_MODEL, object: "model" }] });
      }
      if (!path.endsWith("/chat/completions")) {
        return json({ error: { message: "mock: rota inesperada" } }, 404);
      }
      return json({
        id: "chatcmpl-packed-smoke",
        object: "chat.completion",
        created: 0,
        model: SMOKE_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      });
    },
  });
  try {
    return {
      port: requirePort(server.port ?? 0),
      requests,
      stop: () => {
        if (stopped) return;
        stopped = true;
        void server.stop(true);
      },
    };
  } catch (error) {
    void server.stop(true);
    throw error;
  }
}

/** Filho/mock vivos, para o handler de sinal encerrar antes de remover o temporário. */
export interface CleanupRegistry {
  child?: { kill: (signal?: NodeJS.Signals) => void; readonly exited: Promise<number>; readonly exitCode: number | null };
  mock?: { stop: () => void };
  /** Limpeza única: todo chamador recebe esta mesma promise (idempotente). */
  releasing?: Promise<void>;
}

async function doRelease(registry: CleanupRegistry, graceMs: number): Promise<void> {
  const mock = registry.mock;
  registry.mock = undefined;
  if (mock !== undefined) {
    try { mock.stop(); } catch { /* já parado */ }
  }
  const child = registry.child;
  registry.child = undefined;
  if (child === undefined) return;
  try { child.kill(); } catch { /* já morto */ }
  const exited = child.exited.catch(() => -1);
  if (await Promise.race([exited, Bun.sleep(graceMs).then(() => undefined)]) !== undefined) return;
  // Sem saída na carência: SIGKILL antes de remover diretórios (Windows segura o `cwd`).
  try { child.kill("SIGKILL"); } catch { /* já morto */ }
  await Promise.race([exited, Bun.sleep(EXIT_MS)]);
}

/**
 * Encerra filho e mock e espera o filho sair (Windows segura o `cwd` até lá).
 * Memoizada: o `finally` do plano e o handler de sinal compartilham a mesma
 * limpeza — o filho é morto uma vez e o SIGKILL só entra se o kill normal não
 * bastar na carência.
 */
export function releaseResources(registry: CleanupRegistry, graceMs = KILL_GRACE_MS): Promise<void> {
  registry.releasing ??= doRelease(registry, graceMs);
  return registry.releasing;
}

interface TuiContext {
  projectDir: string;
  home: string;
  pkgDir: string;
  version: string;
}

/** Decisão do boot da TUI: com frame é `passed`; sem frame é erro, nunca "pulado". */
export interface TuiBoot {
  status: "passed";
  frame: string;
}

/**
 * Erro do boot da TUI: `SmokeError` sempre — não existe resultado "pulado".
 * Sem frame e com "precisa de um terminal", o preload não rodou: falha fechada.
 */
export function tuiBootError(output: string, exitCode: number | null): SmokeError {
  if (NEEDS_TTY.test(output)) {
    return new SmokeError(
      "o pacote reportou falta de terminal interativo: o preload scripts/packed-smoke-tty.ts não rodou. "
      + "A etapa TUI é obrigatória e fecha o run como falha:\n"
      + failureTail(output),
    );
  }
  return new SmokeError(
    `a TUI não desenhou o primeiro frame em ${FIRST_FRAME_MS / 1000}s (exit ${exitCode ?? "n/a"}):\n${failureTail(output)}`,
  );
}

/**
 * Decisão pura do boot, para teste: o tipo não admite `skipped`, então a etapa
 * não tem como "passar" sem primeiro frame (é o gate do #542).
 */
export function bootOutcome(output: string, exitCode: number | null): TuiBoot {
  const frame = firstFrame(output);
  if (frame === undefined) throw tuiBootError(output, exitCode);
  return { status: "passed", frame };
}

/** Boot da TUI instalada contra o mock; etapa obrigatória, falha sem frame ou sem TTY. */
async function runTui(ctx: TuiContext, registry: CleanupRegistry): Promise<StepOutcome> {
  const shim = join(resolve(import.meta.dir), "packed-smoke-tty.ts");
  const cli = join(ctx.pkgDir, "dist", "cli.js");
  const bun = packagedBun(ctx.pkgDir);
  for (const file of [shim, cli]) {
    if (!existsSync(file)) throw new SmokeError(`arquivo ausente no pacote instalado: ${file}`);
  }

  const mock = startMock();
  registry.mock = mock;
  prepareHome(ctx.home, ctx.projectDir, mock.port);

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
  registry.child = child;

  const decoder = new TextDecoder();
  let out = "";
  let err = "";
  void (async () => { for await (const chunk of child.stdout) out += decoder.decode(chunk); })();
  void (async () => { for await (const chunk of child.stderr) err += decoder.decode(chunk); })();

  const tail = (): string => failureTail(`${out}\n${err}`);
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
  const assertSingleChat = (when: string): void => {
    const problem = completionProblem(mock.requests, {
      model: SMOKE_MODEL,
      prompt: SMOKE_PROMPT,
      key: SMOKE_KEY_VALUE,
    });
    if (problem !== undefined) throw new SmokeError(`${when}: ${problem}`);
  };
  const tuiOutput = (): string => `${out}\n${err}`;

  try {
    // Falha rápido quando o filho morre (ex.: "precisa de um terminal"): o
    // preload não rodou e esperar 30 s só atrasaria o mesmo erro.
    const deadline = Date.now() + FIRST_FRAME_MS;
    while (Date.now() < deadline && firstFrame(out) === undefined && child.exitCode === null) {
      await Bun.sleep(POLL_MS);
    }
    const frame = bootOutcome(tuiOutput(), child.exitCode).frame;

    // `/providers` → `t` → enter: health real (GET /v1/models) até `ok` com latência.
    await write("/providers");
    await Bun.sleep(100);
    await write("\r");
    if (!await waitUntil(() => /t testar/.test(plainOutput(out)), SCREEN_MS)) {
      throw new SmokeError(`/providers não abriu em ${SCREEN_MS / 1000}s:\n${tail()}`);
    }
    await write("t");
    if (!await waitUntil(() => providerTestPrompt(out), SCREEN_MS)) {
      throw new SmokeError(`/providers não pediu confirmação do teste em ${SCREEN_MS / 1000}s:\n${tail()}`);
    }
    await write("\r");
    if (!await waitUntil(() => providerOk(out), SCREEN_MS)) {
      throw new SmokeError(`/providers não mostrou "ok" com latência em ${SCREEN_MS / 1000}s:\n${tail()}`);
    }
    const healthLine = requiredProviderOkLine(out);
    // Volta para a conversa: esc fecha a tela de providers.
    await write("\u001b");
    await Bun.sleep(200);

    await write(SMOKE_PROMPT);
    // Enter em chunk separado: junto do texto, o turno não abre.
    await Bun.sleep(100);
    await write("\r");
    if (!await waitUntil(() => chatRequests(mock.requests).length > 0, TURN_MS)) {
      throw new SmokeError(`o mock não recebeu requisição de turno em ${TURN_MS / 1000}s:\n${tail()}`);
    }
    assertSingleChat("durante o turno");
    // Footer só mostra turnos concluídos (#480): prova que o turno fechou.
    if (!await waitUntil(() => hasClosedTurn(out), TURN_MS)) {
      throw new SmokeError(`o turno não fechou em ${TURN_MS / 1000}s:\n${tail()}`);
    }
    // Reavalia depois do footer: uma segunda chamada não pode entrar no meio.
    assertSingleChat("depois do footer");

    // `/log` (#514): header da sessão com endpoint + linhas de turno.
    await write("/log");
    await Bun.sleep(100);
    await write("\r");
    if (!await waitUntil(() => logHeaderShown(out, ctx.version, mock.port) && turnLogged(out), SCREEN_MS)) {
      throw new SmokeError(`/log não mostrou o header com endpoint e a linha de turno em ${SCREEN_MS / 1000}s:\n${tail()}`);
    }
    // esc volta da tela de log para a conversa; ctrl+c no /log só fecharia a tela.
    await write("\u001b");
    await Bun.sleep(200);

    // O filho já estar morto aqui invalidaria o "ctrl+c exit 0" abaixo.
    if (child.exitCode !== null) {
      throw new SmokeError(`a TUI já tinha saído (exit ${child.exitCode}) antes do ctrl+c:\n${tail()}`);
    }
    await write("\u0003");
    const exit = await Promise.race([child.exited, Bun.sleep(EXIT_MS).then(() => undefined)]);
    if (exit === undefined) {
      child.kill();
      throw new SmokeError(`a TUI não saiu em ${EXIT_MS / 1000}s após ctrl+c; processo encerrado`);
    }
    if (exit !== 0) throw new SmokeError(`a TUI saiu com código ${exit} após ctrl+c:\n${tail()}`);
    // Última checagem: depois do ctrl+c, nenhuma segunda chamada pode ter entrado.
    assertSingleChat("depois do ctrl+c");

    const how = child.signalCode === null ? `exit ${exit}` : `exit ${exit} (${child.signalCode})`;
    return {
      status: "passed",
      detail: `frame "${frame}" · ${healthLine} · /log com endpoint http://127.0.0.1:${mock.port}/v1 e turno · 1 POST no mock · ${how}`,
    };
  } finally {
    await releaseResources(registry);
  }
}

export interface PlanStep {
  id: string;
  label: string;
  /** Sem esta etapa o gate não prova o que promete: `skipped` fecha o run como falha. */
  required: boolean;
  body: () => Promise<StepOutcome> | StepOutcome;
}

/** Executa o plano em ordem, para na primeira falha e marca o resto como não rodado. */
export async function runPlan(
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
      if (outcome.status === "skipped" && step.required) {
        const message = `etapa obrigatória pulada: ${redactSmokeText(outcome.detail)}`;
        results.push({ id: step.id, status: "failed", detail: message });
        failure = `${step.id}: ${message}`;
        emit(`  falhou: ${message}`);
        continue;
      }
      results.push({ id: step.id, status: outcome.status, detail: outcome.detail });
      emit(`  ${outcome.status === "passed" ? "ok" : "pulado"}: ${outcome.detail}`);
    } catch (error) {
      const message = redactSmokeText(error instanceof Error ? error.message : String(error));
      results.push({ id: step.id, status: "failed", detail: message });
      failure = `${step.id}: ${message}`;
      emit(`  falhou: ${message}`);
    }
  }
  return { results, failure };
}

export interface SmokePlanContext {
  root: string;
  name: string;
  version: string;
  packDir: string;
  projectDir: string;
  home: string;
  pkgDir: string;
}

/**
 * Plano do smoke, extraído para teste: toda etapa é obrigatória, inclusive a
 * TUI. A única forma de o resumo sair `ok` é esta lista passar inteira.
 */
export function planSteps(ctx: SmokePlanContext, registry: CleanupRegistry = {}): PlanStep[] {
  let tarball = "";
  const tarballName = tarballFileName(ctx.name, ctx.version);
  return [
    {
      id: "build",
      label: "build do repo",
      required: true,
      body: () => {
        const result = run([process.execPath, "run", "build"], ctx.root, smokeEnv(), STEP_TIMEOUT_MS);
        if (result.code !== 0) throw new SmokeError(`bun run build falhou (exit ${result.code}):\n${outputOf(result)}`);
        return { status: "passed", detail: "dist/cli.js e dist/launcher.js" };
      },
    },
    {
      id: "pack",
      label: "npm pack",
      required: true,
      body: () => {
        const npm = npmBinary();
        const result = run([npm, "pack", "--pack-destination", ctx.packDir], ctx.root, smokeEnv(), STEP_TIMEOUT_MS);
        if (result.code !== 0) throw new SmokeError(`npm pack falhou (exit ${result.code}):\n${outputOf(result)}`);
        const tarballs = readdirSync(ctx.packDir).filter((file) => file.endsWith(".tgz"));
        if (tarballs.length !== 1 || tarballs[0] !== tarballName) {
          throw new SmokeError(`npm pack: esperava ${tarballName}; encontrei ${tarballs.join(", ") || "nada"}`);
        }
        tarball = join(ctx.packDir, tarballName);
        return { status: "passed", detail: tarballName };
      },
    },
    {
      id: "install",
      label: "instalação limpa do tarball",
      required: true,
      body: () => {
        const npm = npmBinary();
        const result = run(
          [npm, "install", "--no-audit", "--no-fund", tarball],
          ctx.projectDir,
          npmInstallEnv(ctx.packDir),
          STEP_TIMEOUT_MS,
        );
        if (result.code !== 0) throw new SmokeError(`npm install falhou (exit ${result.code}):\n${outputOf(result)}`);
        const manifest = JSON.parse(readFileSync(join(ctx.pkgDir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name !== ctx.name || manifest.version !== ctx.version) {
          throw new SmokeError(`pacote instalado diverge do repo: ${String(manifest.name)}@${String(manifest.version)}`);
        }
        if (!existsSync(installedAstroBin(ctx.projectDir))) {
          throw new SmokeError("npm install não criou node_modules/.bin/astro");
        }
        return { status: "passed", detail: `${ctx.name}@${ctx.version}` };
      },
    },
    {
      id: "version",
      label: "astro --version no pacote instalado",
      required: true,
      body: () => {
        const node = nodeBinary();
        const result = run([node, join(ctx.pkgDir, "dist", "launcher.js"), "--version"], ctx.projectDir, smokeEnv(), STEP_TIMEOUT_MS);
        const expected = `astro ${ctx.version}`;
        if (result.code !== 0 || result.out.trim() !== expected) {
          throw new SmokeError(`esperava "${expected}" (exit 0); veio exit ${result.code}:\n${outputOf(result)}`);
        }
        return { status: "passed", detail: expected };
      },
    },
    {
      id: "help",
      label: "astro --help no pacote instalado",
      required: true,
      body: () => {
        const node = nodeBinary();
        const result = run([node, join(ctx.pkgDir, "dist", "launcher.js"), "--help"], ctx.projectDir, smokeEnv(), STEP_TIMEOUT_MS);
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
      required: true,
      body: () => {
        const node = nodeBinary();
        const result = run(
          [node, join(ctx.pkgDir, "dist", "launcher.js"), "doctor"],
          ctx.projectDir,
          smokeEnv({ ASTRO_HOME: ctx.home }),
          STEP_TIMEOUT_MS,
        );
        if (result.code !== 0 || !doctorClean(result.out)) {
          throw new SmokeError(`doctor com falha (exit ${result.code}):\n${outputOf(result)}`);
        }
        return { status: "passed", detail: "0 fail, home temporário" };
      },
    },
    {
      id: TUI_STEP_ID,
      label: "TUI instalada com provider mock em loopback",
      // Sem tolerância: o preload falsifica o TTY, então `skipped` nunca é legítimo.
      required: true,
      body: () => runTui(
        { projectDir: ctx.projectDir, home: ctx.home, pkgDir: ctx.pkgDir, version: ctx.version },
        registry,
      ),
    },
  ];
}

export interface SmokeSummary {
  ok: boolean;
  packageName: string;
  version: string;
  tuiBooted: boolean;
  steps: StepResult[];
  failure: string | null;
  /** Remoções que falharam no fim: aparecem no `--json` mesmo com outra falha. */
  cleanupWarnings: string[];
}

/** A TUI só "bootou" se a etapa existe e passou. */
export function tuiBooted(results: readonly StepResult[]): boolean {
  return results.some((result) => result.id === TUI_STEP_ID && result.status === "passed");
}

/**
 * Resumo do `--json`: `ok` exige a TUI bootada, não apenas ausência de falha.
 * Etapa obrigatória pulada já falha o run; o campo explícito impede que um
 * futuro atalho faça o resumo mentir sobre o boot.
 */
export function summaryFor(
  name: string,
  version: string,
  results: readonly StepResult[],
  failure: string | null,
  cleanupWarnings: readonly string[] = [],
): SmokeSummary {
  const booted = tuiBooted(results);
  return {
    ok: failure === null && booted,
    packageName: name,
    version,
    tuiBooted: booted,
    steps: [...results],
    failure,
    cleanupWarnings: [...cleanupWarnings],
  };
}

/** Código de saída do resumo: só zero sem falha. */
export function exitCodeFor(failure: string | null): number {
  return failure === null ? 0 : 1;
}

/** Linha final: toda etapa é obrigatória, então não existe contador de puladas. */
export function okLine(count: number): string {
  return `smoke:packed ok (${count} etapas, nenhuma etapa pode ser pulada)`;
}

/** Dependências do handler de sinal, injetadas para teste (fs, `exit`, `process.on`). */
export interface SignalCleanupDeps {
  remove: (dir: string) => void;
  exit: (code: number) => void;
  onSignal: (signal: "SIGINT" | "SIGTERM", handler: () => void) => () => void;
  warn: (message: string) => void;
}

/**
 * Handler idempotente: a primeira chamada mata o filho, remove cada diretório e
 * sai uma vez (130 no SIGINT, 143 no SIGTERM); as demais recebem a mesma
 * promise, então um segundo sinal não repete remoção nem `exit`.
 */
export function createSignalCleanup(
  dirs: readonly string[],
  registry: CleanupRegistry,
  deps: SignalCleanupDeps,
): (signal: "SIGINT" | "SIGTERM") => Promise<void> {
  let pending: Promise<void> | undefined;
  return (signal) => {
    pending ??= (async () => {
      await releaseResources(registry);
      for (const dir of dirs) {
        try {
          deps.remove(dir);
        } catch (error) {
          const message = redactSmokeText(error instanceof Error ? error.message : String(error));
          deps.warn(`smoke:packed: falha ao limpar ${dir} no sinal: ${message}\n`);
        }
      }
      deps.exit(signal === "SIGINT" ? 130 : 143);
    })();
    return pending;
  };
}

/**
 * Ctrl-C/SIGTERM não pode deixar temporário com `node_modules` nem filho vivo.
 * Filho e mock são encerrados e aguardados ANTES do `rm` (Windows segura o
 * `cwd`), cada diretório é removido com retry e o processo sai uma vez só.
 * No Windows um `child.kill()` programático chega em `exit=143` sem passar por
 * este handler (docs/release.md §5).
 */
export function installCleanupHandlers(
  dirs: readonly string[],
  registry: CleanupRegistry,
  deps: Partial<SignalCleanupDeps> = {},
): () => void {
  const onSignal = deps.onSignal ?? ((signal: "SIGINT" | "SIGTERM", handler: () => void) => {
    process.on(signal, handler);
    return () => { process.off(signal, handler); };
  });
  const cleanup = createSignalCleanup(dirs, registry, {
    remove: deps.remove ?? removeTempDirWithRetry,
    exit: deps.exit ?? ((code) => { process.exit(code); }),
    warn: deps.warn ?? ((message) => { process.stderr.write(message); }),
    onSignal,
  });
  const offs = (["SIGINT", "SIGTERM"] as const)
    .map((signal) => onSignal(signal, () => { void cleanup(signal); }));
  return () => { for (const off of offs) off(); };
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
  // Uma raiz só (pack/project/home): o handler entra logo depois da criação e
  // o `finally` remove tudo de uma vez, mesmo se um `mkdir`/`writeFile` falhar.
  const dirs = createSmokeDirs();
  const registry: CleanupRegistry = {};
  const clearSignalHandlers = installCleanupHandlers([dirs.root], registry);
  const emit = options.json ? () => {} : (line: string) => console.log(line);
  const cleanupWarnings: string[] = [];
  let results: StepResult[] = [];
  let failure: string | null = null;

  try {
    writeFileSync(
      join(dirs.projectDir, "package.json"),
      `${JSON.stringify({ name: "astro-packed-smoke", private: true }, null, 2)}\n`,
    );
    const pkgDir = join(dirs.projectDir, "node_modules", ...meta.name.split("/"));

    if (!options.json) {
      console.log(`smoke:packed: ${meta.name}@${meta.version}`);
      console.log(`smoke:packed: temporário ${dirs.root}`);
    }

    const plan = await runPlan(planSteps({
      root,
      name: meta.name,
      version: meta.version,
      packDir: dirs.packDir,
      projectDir: dirs.projectDir,
      home: dirs.home,
      pkgDir,
    }, registry), emit);
    results = plan.results;
    failure = plan.failure;
  } catch (error) {
    // Fora do `runPlan` (mkdir/write do projeto): falha do run, não stack cru.
    failure = redactSmokeText(error instanceof Error ? error.message : String(error));
  } finally {
    // Filho/mock primeiro (promise memoizada): o `rm` só funciona com eles fora.
    await releaseResources(registry);
    // Uma raiz só: um `rm`, um aviso — que nunca é engolido no `--json`.
    try {
      removeTempDirWithRetry(dirs.root);
    } catch (error) {
      const message = redactSmokeText(error instanceof Error ? error.message : String(error));
      cleanupWarnings.push(`falha ao limpar ${dirs.root}: ${message}`);
      if (failure === null) failure = `cleanup: ${message}`;
    }
    // Handlers saem só depois do laço: um sinal no meio ainda limpa tudo.
    clearSignalHandlers();
  }

  const summary = summaryFor(meta.name, meta.version, results, failure, cleanupWarnings);
  // `ok` também exige o boot da TUI: sem ele o run não pode sair 0.
  const effectiveFailure = summary.ok ? null : (failure ?? "a etapa TUI não bootou");

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const warning of cleanupWarnings) console.error(`smoke:packed: aviso: ${warning}`);
    if (effectiveFailure === null) console.log(okLine(results.length));
    else console.error(`smoke:packed falhou: ${effectiveFailure}`);
  }
  return exitCodeFor(effectiveFailure);
}

if (import.meta.main) process.exit(await main());
