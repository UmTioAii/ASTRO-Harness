import { expect, test } from "bun:test";
import {
  SMOKE_KEY_ENV,
  SMOKE_KEY_VALUE,
  SMOKE_MODEL,
  SMOKE_PROMPT,
  completionProblem,
  firstFrame,
  parseArgs,
  smokeConfig,
  trustState,
  type RecordedRequest,
} from "../scripts/packed-smoke";

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
  expect(parseArgs([])).toEqual({ json: false, help: false });
  expect(parseArgs(["--json"])).toEqual({ json: true, help: false });
  expect(parseArgs(["--help"])).toEqual({ json: false, help: true });
  expect(() => parseArgs(["--publish"])).toThrow("--publish");
});
