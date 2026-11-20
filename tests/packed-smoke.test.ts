import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SMOKE_KEY_ENV,
  SMOKE_KEY_VALUE,
  SMOKE_MODEL,
  SMOKE_PROMPT,
  SmokeError,
  completionProblem,
  firstFrame,
  packagedBun,
  parseArgs,
  redactSmokeText,
  runPlan,
  smokeConfig,
  trustState,
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

test("parseArgs aceita --json e recusa argumento desconhecido", () => {
  expect(parseArgs([])).toEqual({ json: false, help: false, allowSkipTui: false });
  expect(parseArgs(["--json"])).toEqual({ json: true, help: false, allowSkipTui: false });
  expect(parseArgs(["--help"])).toEqual({ json: false, help: true, allowSkipTui: false });
  expect(parseArgs(["--allow-skip-tui"])).toEqual({ json: false, help: false, allowSkipTui: true });
  expect(() => parseArgs(["--publish"])).toThrow("--publish");
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
