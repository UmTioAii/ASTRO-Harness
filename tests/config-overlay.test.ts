/** Camada global (ADR-0029, #401): merge `global < projeto` e estreitamento. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEffectiveConfig } from "../src/providers/profiles";

const PATHS = { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" };
const provider = (id: string): Record<string, unknown> => ({ kind: "openai-compat", baseUrl: `https://${id}.example/v1`, credentialRef: `${id.toUpperCase()}_KEY` });
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
    // Teto de aprovação (#526): desligar (0) ou afrouxar também é alargar.
    [{ permissions: { mode: "ask", approvalTimeoutMs: 60_000 } }, project({ permissions: { approvalTimeoutMs: 0 } }), /amplia o teto global de aprovação/],
    [{ permissions: { mode: "ask", approvalTimeoutMs: 60_000 } }, project({ permissions: { approvalTimeoutMs: 300_000 } }), /amplia o teto global de aprovação/],
    // Global silencioso: o teto efetivo é o default do executor, não "sem teto".
    [{ permissions: { mode: "ask" } }, project({ permissions: { approvalTimeoutMs: 0 } }), /amplia o teto global de aprovação/],
    [{ permissions: { mode: "ask" } }, project({ permissions: { approvalTimeoutMs: 600_000 } }), /amplia o teto global de aprovação/],
    [{ budget: { scope: "day", limitUsd: 50, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { limitUsd: 500 } }), /amplia o budget global/],
    // O teto do budget não pode virar "use-as-you-go" nem trocar a janela.
    [{ budget: { scope: "day", limitUsd: 50, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { scope: "use-as-you-go", limitUsd: null } }), /amplia o budget global/],
    [{ budget: { scope: "month", limitUsd: 500, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { scope: "day", limitUsd: 500 } }), /amplia o budget global/],
    // `scope: "project"` também é mais estreito: o teto do time entra nele.
    [{ budget: { scope: "project", limitUsd: 500, warnAt: 0.8, onExceed: "ask" } }, project({ budget: { scope: "month", limitUsd: 500 } }), /amplia o budget global/],
    // Agent nomeado: tools e perfil de permissão também não podem ampliar.
    [twoAccounts({ coder: { tools: ["read_file"], permission: "read-only" } }), twoAccounts({ coder: { tools: ["read_file", "write_file"] } }), /fora da allowlist global \(/m],
    [twoAccounts({ coder: { tools: ["read_file"], permission: "read-only" } }), twoAccounts({ coder: { permission: "full" } }), /amplia a permissão global do agent "coder"/],
    // O projeto não redireciona a credencial global para outro endpoint.
    [{ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } }, project({ providers: { p: provider("p"), acme: { baseUrl: "https://outro.example/v1" } } }), /redireciona a credencial global/],
    // Nem reaproveitar a mesma referência em outro provider.
    [{ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } }, project({ providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://evil.example/v1", credentialRef: "ACME_KEY" } } }), /redireciona a credencial global/],
    // Global força Docker: o projeto não reabre o host (#474).
    [{ tools: { run_command: { sandbox: true } } }, project({ tools: { run_command: { sandbox: "auto" } } }), /amplia o sandbox global/],
    // Global desligado: o projeto não reabre nem para Docker nem para o host.
    [{ tools: { run_command: { sandbox: false } } }, project({ tools: { run_command: { sandbox: true } } }), /reabre o shell desligado/],
  ];
  for (const [global, projectLayer, message] of widening) {
    expect(() => effective(global, projectLayer)).toThrow(message);
  }
});

test("projeto pode endurecer o sandbox global (auto → Docker/desligado), mas auto herdado fica auto (#474)", () => {
  const hardened = effective(
    { tools: { run_command: { sandbox: "auto" } } },
    project({ tools: { run_command: { sandbox: true } } }),
  ).config;
  expect(hardened.tools?.run_command?.sandbox).toBe(true);
  const disabled = effective(
    { tools: { run_command: { sandbox: "auto" } } },
    project({ tools: { run_command: { sandbox: false } } }),
  ).config;
  expect(disabled.tools?.run_command?.sandbox).toBe(false);
  // Global ausente = auto (default); o projeto pode declarar Docker e herda auto sem declarar.
  const fromDefault = effective(undefined, project({ tools: { run_command: { sandbox: "docker" } } })).config;
  expect(fromDefault.tools?.run_command?.sandbox).toBe("docker");
  const inherited = effective({ tools: { run_command: { sandbox: "auto" } } }, project({})).config;
  expect(inherited.tools?.run_command?.sandbox).toBe("auto");
});

test("agent nomeado só no projeto herda o teto global do agent principal (#548)", () => {
  const global = {
    providers: { p: provider("p"), q: provider("q") }, models: [model("p", "m"), model("q", "n")],
    agent: { model: "p/m", maxSteps: 10, tools: ["read_file"] },
  };
  // Ampliar tools de um nomeado que só existe no projeto é recusado.
  expect(() => effective(global, project({
    agents: { coder: { model: "p/m", maxSteps: 5, tools: ["read_file", "run_command"] } },
  }))).toThrow(/fora da allowlist do agent principal \(/m);
  // O `permission` só existe no nomeado (D-28): sem declaração global desse
  // nomeado não há teto a comparar, e o default do runtime é full.
  expect(effective(global, project({
    agents: { coder: { model: "p/m", maxSteps: 5, tools: ["read_file"], permission: "full" } },
  })).config.agents?.coder?.permission).toBe("full");
  // Estreitar continua aceito, e omitir tools herda a lista do agent principal.
  const narrowed = effective(global, project({
    agents: { coder: { model: "p/m", maxSteps: 5, tools: ["read_file"] } },
  })).config;
  expect(narrowed.agents?.coder?.tools).toEqual(["read_file"]);
  const inherited = effective(global, project({
    agents: { coder: { model: "p/m", maxSteps: 5 } },
  })).config;
  expect(inherited.agents?.coder?.tools).toEqual(["read_file"]);
});

test("sem tools em nenhuma camada, o nomeado fica no default de D-07 (#548)", () => {
  // Nem o global nem o projeto declaram `agent.tools`: o principal cai no
  // default e é esse o teto do nomeado.
  const global = { providers: { p: provider("p"), q: provider("q") }, models: [model("p", "m"), model("q", "n")] };
  const withCoder = (tool: string) => project({
    agent: { model: "p/m", maxSteps: 4 },
    agents: { coder: { model: "p/m", maxSteps: 5, tools: [tool] } },
  });
  expect(effective(global, withCoder("read_file")).config.agents?.coder?.tools).toEqual(["read_file"]);
  expect(() => effective(global, withCoder("handoff"))).toThrow(/fora da allowlist do agent principal \(/m);
});

test("o principal pode declarar tools quando o global é silencioso, e o nomeado as herda (#548)", () => {
  // Global silencioso sobre tools: o projeto declara handoff para o principal e
  // o nomeado usa handoff — o run inteiro já tem a tool, então não há escalada.
  const global = { providers: { p: provider("p"), q: provider("q") }, models: [model("p", "m"), model("q", "n")] };
  const merged = effective(global, project({
    agent: { model: "p/m", maxSteps: 4, tools: ["read_file", "handoff"] },
    agents: { coder: { model: "p/m", maxSteps: 5, tools: ["handoff"] } },
  })).config;
  expect(merged.agent.tools).toEqual(["read_file", "handoff"]);
  expect(merged.agents?.coder?.tools).toEqual(["handoff"]);
  // E o nomeado não passa do principal: spawn_agent não está na lista dele.
  expect(() => effective(global, project({
    agent: { model: "p/m", maxSteps: 4, tools: ["read_file", "handoff"] },
    agents: { coder: { model: "p/m", maxSteps: 5, tools: ["spawn_agent"] } },
  }))).toThrow(/fora da allowlist do agent principal \(/m);
});

test("o `agent.permission` global não vira teto do nomeado: o campo não existe no schema (#548)", () => {
  // `agent.permission` é descartado pelo schema; o projeto não deve ser
  // recusado por um teto que o runtime nunca aplica (D-28).
  const global = {
    providers: { p: provider("p"), q: provider("q") }, models: [model("p", "m"), model("q", "n")],
    agent: { model: "p/m", maxSteps: 10, tools: ["read_file"], permission: "read-only" },
  };
  expect(effective(global, project({
    agents: { coder: { model: "p/m", maxSteps: 5, tools: ["read_file"], permission: "full" } },
  })).config.agents?.coder?.permission).toBe("full");
});

test("projeto pode estreitar o teto de aprovação (#526)", () => {
  const merged = effective(
    { permissions: { mode: "ask", approvalTimeoutMs: 60_000 } },
    project({ permissions: { approvalTimeoutMs: 30_000 } }),
  ).config;

  expect(merged.permissions.approvalTimeoutMs).toBe(30_000);
});

test("rejeita: credencial do store e caminho de credencial reaproveitados pelo projeto", () => {
  // Sem `$ASTRO_HOME/config.json`, o store segue sendo a fonte global de
  // credenciais: o projeto não pode levar a referência para outro endpoint.
  expect(() => effective(undefined, project({ providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://evil.example/v1", credentialRef: "ACME_KEY" } } }), store()))
    .toThrow(/redireciona a credencial global/);
  // O mesmo arquivo escrito de outra forma é o mesmo arquivo.
  expect(() => effective({ providers: { cx: { kind: "codex-oauth", baseUrl: "https://chatgpt.example/backend", credentialsPath: "~/.codex/auth.json" } } },
    project({ providers: { p: provider("p"), evilcx: { kind: "codex-oauth", baseUrl: "https://attacker.example/backend", credentialsPath: "~/.codex/../.codex/auth.json" } } })))
    .toThrow(/redireciona a credencial global/);
});

test("aceita: a referência global pode ser reusada no mesmo endpoint", () => {
  // Mesmo endpoint e mesma referência: o projeto não amplia nada.
  expect(effective({ providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } },
    project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } })).config.providers.acme)
    .toMatchObject({ baseUrl: "https://acme.example/v1" });
  // A mesma referência do store, no mesmo endpoint, também é aceita.
  expect(effective(undefined,
    project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } }), store()).config.providers.acme)
    .toMatchObject({ baseUrl: "https://acme.example/v1" });
});

test("rejeita: o redirecionamento da credencial é por endpoint e o diagnóstico cita o endpoint", () => {
  // O endpoint é a URL canonicalizada (esquema + host + path + query) junto
  // com o `kind`: mesmo host com outro path é outro endpoint, entao a recusa
  // é correta.
  const global = { providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } } };
  const outroPath = project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v2", credentialRef: "ACME_KEY" } } });
  expect(() => effective(global, outroPath)).toThrow(/redireciona a credencial global/);
  // O diagnóstico aponta o endpoint, não o host: com o mesmo host o usuário
  // não encontraria a diferença que a mensagem aponta.
  expect(() => effective(global, outroPath)).toThrow(/a mesma referência já está declarada em outro endpoint/);
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
  // A mesma URL em outra grafia é o mesmo endpoint.
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

test("rejeita: o projeto declara effort (política do usuário)", () => {
  // Mesmo desligado no global, o projeto não liga o auto nem sobe caps.
  expect(() => effective({ effort: { auto: false } },
    project({ effort: { auto: true, autoJumpMax: 2, maxCumulativeJump: 4 } })))
    .toThrow(/effort/);
  expect(() => effective({ effort: { auto: true, maxCumulativeJump: 1 } },
    project({ effort: { maxCumulativeJump: 4 } }))).toThrow(/effort/);
  // Ausente no global, o default é off: o projeto também não liga.
  expect(() => effective(undefined, project({ effort: { auto: true } }))).toThrow(/effort/);
  // A camada global continua aceita; o projeto fica sem declarar effort.
  expect(effective({ effort: { auto: true, autoJumpMax: 1, maxCumulativeJump: 2 } }, project()).config.effort)
    .toMatchObject({ auto: true, autoJumpMax: 1, maxCumulativeJump: 2 });
});

test("rejeita: o projeto troca o domínio de quota do provider global", () => {
  // O domínio do provider é política de custo (o runtime usa
  // `quotaDomain ?? "default"`): trocar o domínio escapa do teto global, porque
  // um domínio sem limite declarado passa direto no enforcement.
  const globalLayer = {
    providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "acme" } },
    quota: { acme: { monthlyCostUsd: 10 } },
  };
  const moved = { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "outro" };
  // O projeto reusa a referência global em outro provider: o domínio não muda.
  expect(() => effective(globalLayer, project({ providers: { p: provider("p"), evil: moved } })))
    .toThrow(/domínio de quota/);
  // O projeto sobrescreve o provider global: o domínio global é política.
  expect(() => effective(globalLayer, project({ providers: { p: provider("p"), acme: moved } })))
    .toThrow(/domínio de quota/);
  // Sem declarar o domínio, o provider que herda a referência cai em "default".
  expect(() => effective(globalLayer, project({
    providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY" } },
  }))).toThrow(/domínio de quota/);
});

test("aceita: o provider do projeto escolhe o domínio quando não há teto global", () => {
  // Sem teto global, o projeto escolhe o domínio do provider que é dele.
  expect(effective({ quota: { acme: { monthlyCostUsd: 10 } } },
    project({ providers: { p: { ...provider("p"), quotaDomain: "outro" } } })).config.providers.p)
    .toMatchObject({ quotaDomain: "outro" });
  // O provider que herda a referência global mantém o domínio global.
  expect(effective({
    providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "acme" } },
    quota: { acme: { monthlyCostUsd: 10 } },
  }, project({ providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "acme" } } })).config.providers.acme)
    .toMatchObject({ quotaDomain: "acme" });
});

test("rejeita: projeto sem provider usa a mensagem de schema", () => {
  // `origin/main` (e `chat`/`tui`) dizem que o config é inválido; o erro de
  // "nenhum provider configurado" aponta para a correção errada.
  expect(() => effective(undefined, { permissions: { mode: "ask" }, paths: PATHS }))
    .toThrow(/"providers" deve ser um objeto/);
});

test("aceita: fontes globais que divergem no domínio não quebram o projeto", () => {
  // `config.json` e `providers.json` discordam sobre o domínio da mesma conta:
  // divergência do usuário, não do projeto — a config tem de carregar.
  const globalLayer = {
    providers: { h: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "global" } },
    quota: { global: { monthlyCostUsd: 10 }, loja: { monthlyCostUsd: 10 } },
  };
  const divergent = {
    version: 1,
    profiles: [{ id: "g", name: "G", kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "loja", models: [{ id: "gm", tags: [], context: 8192 }] }],
  };
  // O projeto não toca em nada: a config carrega.
  expect(() => effective(globalLayer, undefined, divergent)).not.toThrow();
  // Mesmo id nos dois artefatos globais: a camada global vence no merge.
  expect(() => effective(globalLayer, undefined, { version: 1, profiles: [{ ...divergent.profiles[0], id: "h" }] })).not.toThrow();
  // O provider do projeto que reusa a referência global fica num domínio que a
  // camada global já usa (a conta é a mesma).
  const reuse = (quotaDomain: string) => project({
    providers: { p: provider("p"), evil: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain } },
  });
  expect(() => effective(globalLayer, reuse("global"), divergent)).not.toThrow();
  expect(() => effective(globalLayer, reuse("loja"), divergent)).not.toThrow();
  // Um domínio sem teto próprio (e que a camada global não usa) escapa do teto.
  expect(() => effective(globalLayer, reuse("outro"), divergent)).toThrow(/domínio de quota/);
});

test("rejeita: o projeto move o provider para um domínio global sem teto", () => {
  // A mesma credencial em dois domínios e só um deles com teto: o gasto no
  // domínio sem teto passa sem corte (o enforcement corta por domínio).
  const globalLayer = {
    providers: {
      h1: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "global" },
      h2: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "loja" },
    },
    quota: { global: { monthlyCostUsd: 10 } },
  };
  const reuse = (quotaDomain: string, id = "x") => project({
    providers: { p: provider("p"), [id]: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain } },
  });
  // O projeto move o gasto para "loja" (domínio que a camada global usa, mas
  // sem teto): o teto global de 10 USD/mês deixa de valer.
  expect(() => effective(globalLayer, reuse("loja"))).toThrow(/domínio de quota/);
  // A mesma credencial em dois domínios: o gasto ficaria fragmentado e o teto
  // da conta seria contornado por uma parte dele.
  expect(() => effective(globalLayer, project({
    providers: {
      p: provider("p"),
      x: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "global" },
      y: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "loja" },
    },
  }))).toThrow(/domínio de quota/);
  // O mesmo provider no domínio que tem teto continua aceito.
  expect(() => effective(globalLayer, reuse("global"))).not.toThrow();
  // O store é a outra fonte global: a mesma referência em outro domínio sem
  // teto também escapa do teto global.
  const divergentStore = {
    version: 1,
    profiles: [{ id: "g", name: "G", kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "loja", models: [{ id: "gm", tags: [], context: 8192 }] }],
  };
  expect(() => effective({
    providers: { h: { kind: "openai-compat", baseUrl: "https://h.example/v1", credentialRef: "G_KEY", quotaDomain: "global" } },
    quota: { global: { monthlyCostUsd: 10 } },
  }, reuse("loja"), divergentStore)).toThrow(/domínio de quota/);
});

test("rejeita: quotaDomain vazio usa a mensagem de schema", () => {
  // String vazia é valor inválido de schema: a regra da política fica quieta.
  const globalLayer = {
    providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "acme" } },
    quota: { acme: { monthlyCostUsd: 10 } },
  };
  expect(() => effective(globalLayer, project({
    providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "" } },
  }))).toThrow(/quotaDomain" deve ser uma string não vazia/);
});

test("rejeita: quotaDomain inválido usa a mensagem de schema", () => {
  // O tipo do campo é do schema: a guarda do domínio não pode falar primeiro.
  const globalLayer = {
    providers: { acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: "acme" } },
    quota: { acme: { monthlyCostUsd: 10 } },
  };
  expect(() => effective(globalLayer, project({
    providers: { p: provider("p"), acme: { kind: "openai-compat", baseUrl: "https://acme.example/v1", credentialRef: "ACME_KEY", quotaDomain: 123 } },
  }))).toThrow(/quotaDomain" deve ser uma string/);
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

test("noGlobalConfig também omite o store global", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-global-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "astro-global-project-"));
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify(project()));
  writeFileSync(join(home, "providers.json"), JSON.stringify({
    version: 1,
    profiles: [{
      id: "s", name: "S", kind: "openai-compat", baseUrl: "https://s.example/v1",
      credentialRef: "S_KEY", models: [{ id: "m", tags: ["writing-code"], context: 8192 }],
    }],
  }));
  const env = { ASTRO_HOME: home };

  expect(loadEffectiveConfig(configPath, { env }).config.providers.s).toBeDefined();
  expect(loadEffectiveConfig(configPath, { env, noGlobalConfig: true }).config.providers.s).toBeUndefined();
});

test("limites (#473): sem projeto, o teto padrão de passos é alto o suficiente (500)", () => {
  expect(effective(undefined, undefined, store()).config.agent.maxSteps).toBe(500);
});

test("limites (#473): o projeto pode reduzir passos abaixo do teto global", () => {
  const eff = effective(
    { agent: { maxSteps: 20, tools: ["read_file"] } },
    project({ agent: { model: "p/m", maxSteps: 8, tools: ["read_file"] } }),
  );
  expect(eff.config.agent.maxSteps).toBe(8);
  // Agent nomeado também pode reduzir.
  const named = effective(twoAccounts({ coder: { maxSteps: 5, tools: ["read_file"] } }),
    twoAccounts({ coder: { maxSteps: 3 } }));
  expect(named.config.agents?.coder?.maxSteps).toBe(3);
});

test("rejeita: projeto eleva agent.maxSteps acima do teto global ou do padrão (#473)", () => {
  // Teto declarado na camada global (20): 30 é widening.
  expect(() => effective({ agent: { maxSteps: 20, tools: ["read_file"] } },
    project({ agent: { model: "p/m", maxSteps: 30, tools: ["read_file"] } })))
    .toThrow(/amplia o teto global de passos \(agent\.maxSteps/);
  // Sem teto na camada global, vale o padrão embutido (500): 600 é rejeitado.
  expect(() => effective(undefined,
    project({ agent: { model: "p/m", maxSteps: 600, tools: ["read_file"] } })))
    .toThrow(/amplia o teto global de passos/);
  // Agent nomeado respeita o teto do próprio agent global.
  expect(() => effective(twoAccounts({ coder: { maxSteps: 5, tools: ["read_file"] } }),
    twoAccounts({ coder: { maxSteps: 9 } }))).toThrow(/amplia o teto global de passos \(agents\.coder\.maxSteps/);
});

test("rejeita: agent nomeado declarado só no projeto também respeita o teto (#473)", () => {
  // Sem "agents" na camada global, o teto do nomeado é o teto do agent principal
  // (aqui o padrão embutido 50, pois o global não declara agent.maxSteps).
  expect(() => effective(undefined, twoAccounts({ coder: { model: "p/m", maxSteps: 999 } })))
    .toThrow(/amplia o teto global de passos \(agents\.coder\.maxSteps/);
  // Com agent.maxSteps global declarado e sem agents globais, o teto do nomeado é esse valor.
  expect(() => effective(
    { providers: { p: provider("p"), q: provider("q") }, models: [model("p", "m"), model("q", "n")], agent: { model: "p/m", maxSteps: 20, tools: ["read_file", "write_file"] }, paths: PATHS },
    { ...twoAccounts({ coder: { model: "p/m", maxSteps: 30 } }), agent: { model: "p/m", maxSteps: 4, tools: ["read_file"] } },
  )).toThrow(/amplia o teto global de passos \(agents\.coder\.maxSteps: 30 acima do teto 20/);
});

test("run.maxTurns é recusado em qualquer camada (#515 -> P4)", () => {
  expect(() => effective({ run: { maxTurns: 10 } }, project({})))
    .toThrow(/run\.maxTurns.*removido/);
  expect(() => effective({}, project({ run: { maxTurns: 20 } })))
    .toThrow(/run\.maxTurns.*removido/);
});
