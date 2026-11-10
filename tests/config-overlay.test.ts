/** Camada global (ADR-0029, #401): merge `global < projeto` e estreitamento. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEffectiveConfig } from "../src/provider/profiles";

const PATHS = { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" };
const provider = (id: string): Record<string, unknown> => ({ kind: "openai-compat", baseUrl: `https://${id}.example/v1`, credentialRef: `${id}_KEY` });
const model = (providerId: string, id: string, context = 8192): Record<string, unknown> => ({ provider: providerId, id, tags: [], context });
/** Projeto base: um provider, um model e as tools mínimas. */
const project = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  providers: { p: provider("p") }, models: [model("p", "m")], agent: { model: "p/m", maxSteps: 4, tools: ["read_file"] }, paths: PATHS, ...over,
});
/** Duas contas (o teto de agents ativos exige duas) e um agent nomeado. */
const twoAccounts = (agents: Record<string, unknown>): Record<string, unknown> => ({
  providers: { p: provider("p"), q: provider("q") }, models: [model("p", "m"), model("q", "n")],
  agent: { model: "p/m", maxSteps: 4, tools: ["read_file", "write_file"] }, agents, paths: PATHS,
});
/** Store global (`providers.json`) com um perfil e o modelo dele. */
const store = (over: Record<string, unknown> = {}): unknown => ({
  version: 1,
  profiles: [{ id: "acme", name: "Acme", kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", models: [{ id: "m", tags: [], context: 8192 }] }],
  ...over,
});
/** Config efetiva das camadas dadas (home e projeto temporários). */
function effective(global: unknown, projectLayer?: unknown, profileStore?: unknown, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "astro-global-home-"));
  const configPath = join(mkdtempSync(join(tmpdir(), "astro-global-project-")), "astro.config.json");
  if (global !== undefined) writeFileSync(join(home, "config.json"), JSON.stringify(global));
  if (profileStore !== undefined) writeFileSync(join(home, "providers.json"), JSON.stringify(profileStore));
  if (projectLayer !== undefined) writeFileSync(configPath, JSON.stringify(projectLayer));
  return loadEffectiveConfig(configPath, { env: { ASTRO_HOME: home, ...env }, allowMissing: true });
}

test("merge: agent, providers e models (três linhas de resultado da tabela do #401)", () => {
  // 1) o global mantém maxSteps e tools; o projeto sobrescreve só o model.
  expect(effective({ agent: { maxSteps: 12, tools: ["read_file", "grep"] } },
    project({ agent: { model: "p/m" } })).config.agent)
    .toMatchObject({ model: "p/m", maxSteps: 12, tools: ["read_file", "grep"] });
  // 2) providers dos dois layers convivem; o do projeto sobrescreve por chave.
  const providers = effective({
    providers: { openai: provider("openai"), local: { kind: "openai-compat", baseUrl: "https://local.example/v1" } },
    models: [model("openai", "a"), model("local", "b")],
  }, project({
    providers: { local: { baseUrl: "https://local2.example/v1" } },
    models: [model("local", "b")], agent: { model: "local/b", maxSteps: 4, tools: ["read_file"] },
  })).config;
  expect(Object.keys(providers.providers).sort()).toEqual(["local", "openai"]);
  expect(providers.providers.local).toMatchObject({ kind: "openai-compat", baseUrl: "https://local2.example/v1" });
  // 3) models une por provider/id; o projeto prevalece no conflito.
  const models = effective({ providers: { p: provider("p") }, models: [model("p", "a"), model("p", "b", 4096)] },
    project({ models: [model("p", "b", 16384), model("p", "c")], agent: { model: "p/b", maxSteps: 4, tools: ["read_file"] } })).config;
  expect(models.models.map((entry) => entry.id).sort()).toEqual(["a", "b", "c"]);
  expect(models.models.find((entry) => entry.id === "b")?.context).toBe(16384);
  // 4) `model` e `profile` são uma chave lógica: o model do projeto descarta
  //    o profile global (o schema proíbe os dois juntos).
  const exclusive = effective({
    providers: { g: provider("g") }, models: [model("g", "gm")],
    modelPool: { fast: { model: "g/gm" } }, agent: { profile: "fast", maxSteps: 12, tools: ["read_file"] },
  }, project({ agent: { model: "p/m", maxSteps: 4, tools: ["read_file"] } })).config;
  expect(exclusive.agent.model).toBe("p/m");
  expect(exclusive.agent.profile).toBeUndefined();
});

test("rejeita: projeto que amplia a política global (ADR-0029)", () => {
  const widening: [unknown, unknown, RegExp][] = [
    // As três linhas de rejeição da tabela do #401.
    [{ agent: { maxSteps: 4, tools: ["read_file", "grep"] } }, project({ agent: { model: "p/m", maxSteps: 4, tools: ["read_file", "grep", "run_command"] } }), /amplia a allowlist global/],
    [{ permissions: { mode: "ask" } }, project({ permissions: { mode: "bypass" } }), /amplia o modo de permissão global/],
    [{ budget: { scope: "day", limitUsd: 50, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { limitUsd: 500 } }), /amplia o budget global/],
    // O teto do budget não pode virar "use-as-you-go" nem trocar a janela.
    [{ budget: { scope: "day", limitUsd: 50, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { scope: "use-as-you-go", limitUsd: null } }), /amplia o budget global/],
    [{ budget: { scope: "month", limitUsd: 500, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { scope: "day", limitUsd: 500 } }), /amplia o budget global/],
    // `scope: "project"` também é mais estreito: o teto do time entra nele.
    [{ budget: { scope: "project", limitUsd: 500, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { scope: "month", limitUsd: 500 } }), /amplia o budget global/],
    // Agent nomeado: tools e perfil de permissão também não podem ampliar.
    [twoAccounts({ coder: { tools: ["read_file"], permission: "read-only" } }), twoAccounts({ coder: { tools: ["read_file", "write_file"] } }), /amplia a allowlist global do agent "coder"/],
    [twoAccounts({ coder: { tools: ["read_file"], permission: "read-only" } }), twoAccounts({ coder: { permission: "full" } }), /amplia a permissão global do agent "coder"/],
    // O projeto não redireciona a credencial global para outro host.
    [{ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } }, project({ providers: { p: provider("p"), acme: { baseUrl: "https://outro.example/v1" } } }), /redireciona a credencial global/],
    // Nem reaproveitar a mesma referência em outro provider.
    [{ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } }, project({ providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://evil.example/v1", credentialRef: "ACME_KEY" } } }), /redireciona a credencial global/],
  ];
  for (const [global, projectLayer, message] of widening) {
    expect(() => effective(global, projectLayer)).toThrow(message);
  }
});

test("rejeita: credencial do store e caminho de credencial reaproveitados pelo projeto", () => {
  // Sem `$ASTRO_HOME/config.json`, o store segue sendo a fonte global de
  // credenciais: o projeto não pode levar a referência para outro host.
  expect(() => effective(undefined, project({ providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://evil.example/v1", credentialRef: "ACME_KEY" } } }), store()))
    .toThrow(/redireciona a credencial global/);
  // O mesmo arquivo escrito de outra forma é o mesmo arquivo.
  expect(() => effective({ providers: { cx: { kind: "codex-oauth", baseUrl: "https://chatgpt.example/backend", credentialsPath: "~/.codex/auth.json" } } },
    project({ providers: { p: provider("p"), evilcx: { kind: "codex-oauth", baseUrl: "https://attacker.example/backend", credentialsPath: "~/.codex/../.codex/auth.json" } } })))
    .toThrow(/redireciona a credencial global/);
});

test("aceita: a referência global pode ser reusada no mesmo host", () => {
  // Mesmo host e mesma referência: o projeto não amplia nada.
  expect(effective({ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } },
    project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } })).config.providers.acme)
    .toMatchObject({ baseUrl: "https://acme.example/v1" });
  // A mesma referência do store, no mesmo host, também é aceita.
  expect(effective(undefined,
    project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } }), store()).config.providers.acme)
    .toMatchObject({ baseUrl: "https://acme.example/v1" });
});

test("rejeita: modelo do projeto inexistente não é trocado em silêncio pelo do store", () => {
  expect(() => effective({ permissions: { mode: "ask" } }, project({ agent: { model: "p/typo", maxSteps: 4, tools: ["read_file"] } }),
    store({ activeProfileId: "acme" }))).toThrow(/agent.model/);
});

test("camada global sozinha define a config efetiva quando não há projeto", () => {
  const only = effective({
    providers: { g: provider("g") }, models: [model("g", "gm")],
    agent: { model: "g/gm", maxSteps: 6, tools: ["read_file"] },
    permissions: { mode: "allow-edits" }, paths: PATHS,
  });
  expect(only.config.agent.model).toBe("g/gm");
  expect(only.config.permissions.mode).toBe("allow-edits");
  expect(only.activeProvider).toBe("g");
  // A camada global define tools e permissões: o aviso de baseline não vale.
  expect(only.warnings.some((warning) => warning.includes("tools padrão"))).toBe(false);
});

test("ASTRO_NO_GLOBAL_CONFIG=1 e noGlobalConfig isolam a camada do projeto", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-global-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "astro-global-project-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ permissions: { mode: "allow-edits" } }));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify(project()));
  const env = { ASTRO_HOME: home };
  expect(loadEffectiveConfig(configPath, { env }).config.permissions.mode).toBe("allow-edits");
  expect(loadEffectiveConfig(configPath, { env: { ...env, ASTRO_NO_GLOBAL_CONFIG: "1" } }).config.permissions.mode).toBe("ask");
  expect(loadEffectiveConfig(configPath, { env, noGlobalConfig: true }).config.permissions.mode).toBe("ask");
});

test("rejeita: a referência de env com outra grafia é a mesma credencial", () => {
  // O ambiente do Windows não diferencia maiúsculas: a mesma variável com
  // outra grafia resolve a mesma credencial.
  expect(() => effective({ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } },
    project({ providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://evil.example/v1", credentialRef: "acme_key" } } })))
    .toThrow(/redireciona a credencial global/);
});

test("rejeita: o mesmo arquivo de credencial com outro nome", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-global-home-"));
  const dir = join(home, ".codex");
  mkdirSync(dir, { recursive: true });
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, "{}");
  // No Windows o mesmo arquivo tem outra caixa; no POSIX, outro nome (link).
  const alias = process.platform === "win32" ? join(dir, "AUTH.JSON") : join(dir, "alias.json");
  if (process.platform !== "win32") symlinkSync(authPath, alias);
  expect(() => effective({ providers: { cx: { kind: "codex-oauth", baseUrl: "https://chatgpt.example/backend", credentialsPath: authPath } } },
    project({ providers: { p: provider("p"), evilcx: { kind: "codex-oauth", baseUrl: "https://attacker.example/backend", credentialsPath: alias } } })))
    .toThrow(/redireciona a credencial global/);
});

test("aceita: o mesmo endpoint escrito de outro jeito", () => {
  // A mesma URL em outra grafia é o mesmo host.
  expect(effective({ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } },
    project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://ACME.example/v1/", credentialRef: "ACME_KEY" } } })).config.providers.acme)
    .toMatchObject({ baseUrl: "https://ACME.example/v1/" });
});

test("aceita: o perfil efêmero de env não reserva a referência", () => {
  // O perfil `env` é por execução: a reserva é da camada global (config + store).
  expect(effective(undefined,
    project({ providers: { p: { kind: "openai-compat", baseUrl: "https://proxy.example/v1", credentialRef: "OPENAI_API_KEY" } } }),
    undefined, { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" }).config.providers.p)
    .toMatchObject({ baseUrl: "https://proxy.example/v1" });
});

test("rejeita: model e profile na mesma camada", () => {
  const pooled = project({
    providers: { p: provider("p"), q: provider("q") },
    models: [model("p", "m"), model("q", "n")],
    modelPool: { fast: { model: "q/n" } },
    agent: { model: "p/m", profile: "fast", maxSteps: 4, tools: ["read_file"] },
  });
  expect(() => effective({ agent: { maxSteps: 3, tools: ["read_file"] } }, pooled))
    .toThrow(/define "model" e "profile"/);
});

test("rejeita: models duplicados na camada de projeto", () => {
  expect(() => effective(undefined, project({ models: [model("p", "m"), model("p", "m", 4096)] })))
    .toThrow(/modelo duplicado "p\/m" em "models"/);
});

test("rejeita: model que aponta para um provider não declarado", () => {
  expect(() => effective(undefined, project({
    providers: {}, models: [model("p", "m")], agent: { model: "p/m", maxSteps: 4, tools: ["read_file"] },
  }))).toThrow(/aponta para o provider "p", que não está declarado em "providers"/);
});

test("rejeita: o projeto eleva o teto de custo global", () => {
  expect(() => effective({ budget: { scope: "project", limitUsd: 500, warnAt: 0.8, onExceed: "ask" }, team: { projectBudgetUsd: 100 } },
    project({ team: { projectBudgetUsd: 100000 } }))).toThrow(/amplia o budget global/);
  expect(() => effective({ quota: { acme: { monthlyCostUsd: 10 } } },
    project({ quota: { acme: { monthlyCostUsd: 1000 } } }))).toThrow(/amplia o budget global/);
});

test("não ecoa o detalhe do parser no erro de JSON inválido", () => {
  // I-03: o detalhe do parser cita o conteúdo do arquivo ( Bun: `Unexpected
  // identifier "..."`; Node: um trecho do arquivo).
  const secret = ["segredo", "global"].join("-");
  const home = mkdtempSync(join(tmpdir(), "astro-global-home-"));
  writeFileSync(join(home, "config.json"), `{ "credentialRef": ${secret} }`);
  let message = "";
  try {
    loadEffectiveConfig(join(home, "config.json"), { env: { ASTRO_HOME: home }, allowMissing: true });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/não é JSON válido/);
  expect(message).not.toContain("segredo");
});
