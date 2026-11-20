import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SMOKE_KEY_ENV,
  SMOKE_KEY_VALUE,
  SMOKE_MODEL,
  SMOKE_PROMPT,
  SmokeError,
  USAGE,
  completionProblem,
  doctorClean,
  exitCodeFor,
  firstFrame,
  hasClosedTurn,
  logHeaderShown,
  packagedBun,
  parseArgs,
  planSteps,
  prepareHome,
  providerOk,
  redactSmokeText,
  runPlan,
  smokeConfig,
  summaryFor,
  trustState,
  tuiBootError,
  turnLogged,
  type PlanStep,
  type RecordedRequest,
} from "../scripts/packed-smoke";
import { loadHomeState, saveHomeState } from "../src/home-state";
import { TrustedFolders, canonicalFolder } from "../src/trust";

const version = "0.1.0-alpha.4";

function request(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    authorization: `Bearer ${SMOKE_KEY_VALUE}`,
    body: JSON.stringify({
      model: SMOKE_MODEL,
      messages: [
        { role: "system", content: "instruções" },
        { role: "user", content: SMOKE_PROMPT },
      ],
    }),
    ...overrides,
  };
}

const expected = { model: SMOKE_MODEL, prompt: SMOKE_PROMPT, key: SMOKE_KEY_VALUE };

/** Health (`GET /v1/models`) também passa pelo mock; não é requisição de turno. */
function healthRequest(): RecordedRequest {
  return { method: "GET", path: "/v1/models", authorization: `Bearer ${SMOKE_KEY_VALUE}`, body: "" };
}

test("firstFrame acha o header mesmo com ANSI e código de controle", () => {
  const output = [
    "\u001b[?2026hastro · /help para comandos · /exit para sair",
    `\u001b[2K\u001b[GASTRO v${version} · mock/${SMOKE_MODEL} · n/d`,
    "│ > ",
  ].join("\n");
  expect(firstFrame(output, version)).toBe(`ASTRO v${version} · mock/${SMOKE_MODEL} · n/d`);
  expect(firstFrame("│ > \n", version)).toBeUndefined();
  expect(firstFrame(`ASTRO v9.9.9 · mock/${SMOKE_MODEL}`, version)).toBeUndefined();
});

test("completionProblem aceita a requisição esperada", () => {
  expect(completionProblem([request()], expected)).toBeUndefined();
});

test("completionProblem ignora o GET /models do health e conta só o POST do turno", () => {
  expect(completionProblem([healthRequest(), request()], expected)).toBeUndefined();
  expect(completionProblem([healthRequest(), request(), request()], expected)).toContain("esperava 1");
});

test("completionProblem recusa contagem, rota, credencial, modelo e prompt divergentes", () => {
  expect(completionProblem([], expected)).toContain("esperava 1");
  expect(completionProblem([request(), request()], expected)).toContain("esperava 1");
  expect(completionProblem([request({ method: "GET" })], expected)).toContain("chat/completions");
  expect(completionProblem([request({ authorization: undefined })], expected)).toContain("Authorization");
  expect(completionProblem([request()], { ...expected, key: "outra" })).toContain("Authorization");

  const wrongModel = request({ body: JSON.stringify({ model: "outro", messages: [{ role: "user", content: SMOKE_PROMPT }] }) });
  expect(completionProblem([wrongModel], expected)).toContain("modelo");

  const wrongPrompt = request({ body: JSON.stringify({ model: SMOKE_MODEL, messages: [{ role: "user", content: "outro" }] }) });
  expect(completionProblem([wrongPrompt], expected)).toContain("prompt");

  const twoUsers = request({
    body: JSON.stringify({
      model: SMOKE_MODEL,
      messages: [{ role: "user", content: SMOKE_PROMPT }, { role: "user", content: SMOKE_PROMPT }],
    }),
  });
  expect(completionProblem([twoUsers], expected)).toContain("mensagem");
});

test("smokeConfig aponta para loopback com credentialRef e sem o valor da chave", () => {
  const config = smokeConfig(43117);
  const serialized = JSON.stringify(config);
  expect(config.providers).toEqual({
    mock: { kind: "openai-compat", baseUrl: "http://127.0.0.1:43117/v1", credentialRef: SMOKE_KEY_ENV },
  });
  expect(serialized).toContain("127.0.0.1");
  expect(serialized).not.toContain(SMOKE_KEY_VALUE);
  expect(config.agent).toMatchObject({ model: `mock/${SMOKE_MODEL}` });
});

test("trustState grava a pasta do projeto no estado global isolado", () => {
  const state = trustState("C:\\tmp\\astro-packed-smoke");
  expect(state).toEqual({
    version: 1,
    trust: { folders: ["C:\\tmp\\astro-packed-smoke"] },
    migrations: { providers: true, trust: true },
  });
});

test("prepareHome grava config e semeia o trust com o realpath do projeto", () => {
  const base = mkdtempSync(join(tmpdir(), "astro-packed-smoke-home-"));
  const project = join(base, "project");
  const link = join(base, "project-link");
  const home = join(base, "home");
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    // Junction (Windows) / symlink (POSIX): o cwd da TUI pode não ser o realpath,
    // e `ensureTrustedCwd` compara com `canonicalFolder`.
    symlinkSync(project, link, "junction");

    prepareHome(home, link, 43117);

    const config = JSON.parse(readFileSync(join(link, "astro.config.json"), "utf8")) as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(config.providers.mock!.baseUrl).toBe("http://127.0.0.1:43117/v1");

    const statePath = join(home, "state.json");
    expect(loadHomeState(statePath).trust.folders).toEqual([realpathSync(project)]);
    expect(canonicalFolder(link)).not.toBe(link);
    expect(new TrustedFolders(statePath).isTrusted(link)).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("parseArgs aceita --json/--help e não tem escape de TTY", () => {
  expect(parseArgs([])).toEqual({ json: false, help: false });
  expect(parseArgs(["--json"])).toEqual({ json: true, help: false });
  expect(parseArgs(["--help"])).toEqual({ json: false, help: true });
  expect(() => parseArgs(["--allow-skip-tui"])).toThrow("--allow-skip-tui");
  expect(() => parseArgs(["--publish"])).toThrow("--publish");
});

test("USAGE não anuncia tolerância para etapa obrigatória", () => {
  expect(USAGE).not.toContain("--allow-skip-tui");
  expect(USAGE).toContain("--json");
});

const planContext = {
  root: "/repo",
  name: "@umtioai/astro-harness",
  version,
  packDir: "/tmp/pack",
  projectDir: "/tmp/project",
  pkgDir: "/tmp/project/node_modules/@umtioai/astro-harness",
  home: "/tmp/home",
};

test("planSteps marca toda etapa como obrigatória, inclusive a TUI", () => {
  const steps = planSteps(planContext);
  expect(steps.map((step) => step.id)).toEqual(["build", "pack", "install", "version", "help", "doctor", "tui"]);
  expect(steps.filter((step) => !step.required)).toEqual([]);
  expect(steps.every((step) => step.required === true)).toBe(true);
});

test("exitCodeFor traduz o resumo em código de saída", () => {
  expect(exitCodeFor(null)).toBe(0);
  expect(exitCodeFor("tui: etapa obrigatória pulada")).toBe(1);
});

test("summaryFor só é ok com a TUI bootada, mesmo sem falha registrada", () => {
  const sumario = summaryFor("pkg", version, [{ id: "tui", status: "passed", detail: "ok" }], null);
  expect(sumario).toMatchObject({ ok: true, tuiBooted: true, failure: null });

  const pulada = summaryFor("pkg", version, [{ id: "tui", status: "skipped", detail: "pulado" }], null);
  expect(pulada.tuiBooted).toBe(false);
  expect(pulada.ok).toBe(false);

  expect(summaryFor("pkg", version, [{ id: "build", status: "failed", detail: "x" }], "build: x"))
    .toMatchObject({ ok: false, tuiBooted: false });
});

test("tuiBootError falha fechado quando o pacote reporta falta de terminal", () => {
  const semTty = tuiBootError("astro: precisa de um terminal interativo\nsegunda linha", 3);
  expect(semTty).toBeInstanceOf(SmokeError);
  expect(semTty.message).toContain("preload");
  expect(semTty.message).toContain("obrigatória");

  const semFrame = tuiBootError("│ > \n", null);
  expect(semFrame).toBeInstanceOf(SmokeError);
  expect(semFrame.message).toContain("primeiro frame");
  expect(semFrame.message).not.toContain("preload");
});

test("hasClosedTurn e doctorClean não aceitam vizinho numérico", () => {
  expect(hasClosedTurn("home · 1 turno(s) · 8/1 tokens")).toBe(true);
  expect(hasClosedTurn("1 turno(s)")).toBe(true);
  expect(hasClosedTurn("home · 11 turno(s) · 8/1 tokens")).toBe(false);

  expect(doctorClean("Resumo: 8 ok, 0 warn, 0 fail")).toBe(true);
  expect(doctorClean("Resumo: 0 fail")).toBe(true);
  expect(doctorClean("Resumo: 8 ok, 0 warn, 10 fail")).toBe(false);
});

test("logHeaderShown exige a linha da tela /log, não a linha da lane no buffer", () => {
  const header = `ASTRO v${version} · mock/${SMOKE_MODEL} · endpoint http://127.0.0.1:43117/v1`;
  expect(logHeaderShown(header, version, 43117)).toBe(true);
  expect(logHeaderShown(`\u001b[1m${header}\u001b[22m`, version, 43117)).toBe(true);
  expect(logHeaderShown(`[sessão] ${header}`, version, 43117)).toBe(false);
  expect(logHeaderShown(header.replace("43117", "43118"), version, 43117)).toBe(false);
});

test("turnLogged e providerOk ancoram a linha inteira", () => {
  expect(turnLogged("[turno] turno concluído · 1 step(s)")).toBe(true);
  expect(turnLogged("[turno] turno concluído · 11 step(s)")).toBe(true);
  expect(turnLogged("antes [turno] turno concluído · 1 step(s)")).toBe(false);
  expect(turnLogged("[turno] turno concluído · muitos step(s)")).toBe(false);

  expect(providerOk("mock: ok · 12ms")).toBe(true);
  expect(providerOk("mock: down (outage) · 3ms")).toBe(false);
  expect(providerOk("outro: ok · 12ms")).toBe(false);
});

function step(overrides: Partial<PlanStep> & Pick<PlanStep, "id">): PlanStep {
  return {
    label: overrides.id,
    required: true,
    body: () => ({ status: "passed", detail: "ok" }),
    ...overrides,
  };
}

test("runPlan fecha como falha quando uma etapa obrigatória sai pulada", async () => {
  const lines: string[] = [];
  const plan = [
    step({ id: "install" }),
    step({ id: "tui", body: () => ({ status: "skipped", detail: "precisa de TTY" }) }),
    step({ id: "depois" }),
  ];
  const { results, failure } = await runPlan(plan, (line) => lines.push(line));

  expect(failure).toContain("tui");
  expect(failure).toContain("obrigatória");
  expect(results.map((result) => result.status)).toEqual(["passed", "failed", "not-run"]);
  expect(lines.join("\n")).toContain("falhou");
});

test("runPlan só tolera etapa pulada quando ela não é obrigatória", async () => {
  const { results, failure } = await runPlan(
    [step({ id: "tui", required: false, body: () => ({ status: "skipped", detail: "sem TTY" }) })],
    () => {},
  );

  expect(failure).toBeNull();
  expect(results).toEqual([{ id: "tui", status: "skipped", detail: "sem TTY" }]);
});

test("runPlan redige o valor da chave de fixture na mensagem de falha", async () => {
  const { results, failure } = await runPlan([
    step({
      id: "tui",
      body: () => {
        throw new SmokeError(`spawn falhou com Bearer ${SMOKE_KEY_VALUE}`);
      },
    }),
  ], () => {});

  expect(failure).not.toContain(SMOKE_KEY_VALUE);
  expect(results[0]!.detail).not.toContain(SMOKE_KEY_VALUE);
});

test("redactSmokeText apaga a chave da fixture por identidade", () => {
  const redacted = redactSmokeText(`erro: ${SMOKE_KEY_VALUE} recusada`);
  expect(redacted).not.toContain(SMOKE_KEY_VALUE);
  expect(redacted).toContain("[redigido]");
});

test("packagedBun prefere o binário real do pacote de plataforma", () => {
  const platformManifest = join("/pkgs", "@oven", "bun-linux-x64", "package.json");
  expect(packagedBun("/proj/node_modules/@umtioai/astro-harness", {
    platform: "linux",
    arch: "x64",
    resolve: (id) => (id.startsWith("@oven/") ? platformManifest : join("/pkgs", "bun", "package.json")),
    exists: () => true,
    stat: () => ({ size: 60_000_000 }),
  })).toBe(join(platformManifest, "..", "bin", "bun"));
});

test("packagedBun recusa o placeholder de 450 bytes em vez de deixar o spawn falhar", () => {
  expect(() => packagedBun("/proj/node_modules/@umtioai/astro-harness", {
    platform: "linux",
    arch: "x64",
    resolve: () => join("/pkgs", "bun", "package.json"),
    exists: () => true,
    stat: () => ({ size: 450 }),
  })).toThrow(/Bun do pacote instalado/);
});

test("trustState gravado por saveHomeState passa no realpath do TrustedFolders", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-packed-smoke-trust-"));
  const statePath = join(dir, "state.json");
  try {
    const seeded = trustState(canonicalFolder(dir));
    saveHomeState(seeded, statePath);
    expect(loadHomeState(statePath)).toEqual(seeded);
    expect(new TrustedFolders(statePath).isTrusted(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
