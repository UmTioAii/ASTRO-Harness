import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEffectiveConfig,
  profileFromEnv,
  ProviderEnvError,
  resolveEffectiveConfig,
  saveProfileStore,
} from "../src/providers/profiles";
import { ProfileManager } from "../src/providers/profile-manager";
import { testProvider } from "../src/health";
import { runTask } from "../src/core/app";

/** Conjuntos de ambiente por provider (S6, #472), como literais: o teste fixa o contrato. */
const SETS = [
  { id: "openai", key: "OPENAI_API_KEY", model: "OPENAI_MODEL", baseUrl: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1" },
  { id: "nvidia", key: "NVIDIA_API_KEY", model: "NVIDIA_MODEL", baseUrl: "NVIDIA_BASE_URL", defaultBaseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "openrouter", key: "OPENROUTER_API_KEY", model: "OPENROUTER_MODEL", baseUrl: "OPENROUTER_BASE_URL", defaultBaseUrl: "https://openrouter.ai/api/v1" },
] as const;

const BASES = Object.fromEntries(SETS.map((set) => [set.baseUrl, `https://${set.id}.example/v1`]));

function complete(id: string): Record<string, string> {
  const set = SETS.find((item) => item.id === id)!;
  return { [set.key]: "k", [set.model]: `${id}-modelo` };
}

/** Código/mensagem de um erro tipado, sem depender da classe (RED antes do GREEN). */
function codeOf(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

function messageOf(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return "";
}

test("cada provider tem o próprio conjunto e lê só as próprias variáveis", () => {
  for (const set of SETS) {
    const profile = profileFromEnv({ ...complete(set.id), ...BASES })!;
    expect(profile.id).toBe(set.id);
    expect(profile.kind).toBe("openai-compat");
    expect(profile.baseUrl).toBe(BASES[set.baseUrl]);
    expect(profile.credentialRef).toBe(set.key);
    expect(profile.models[0]?.id).toBe(`${set.id}-modelo`);
    expect(profileFromEnv(complete(set.id))?.baseUrl).toBe(set.defaultBaseUrl);
  }
});

test("conjunto parcial nunca seleciona", () => {
  for (const set of SETS) {
    expect(profileFromEnv({ [set.key]: "k" })).toBeUndefined();
    expect(profileFromEnv({ [set.model]: "m" })).toBeUndefined();
    expect(profileFromEnv({ [set.key]: " ", [set.model]: "m" })).toBeUndefined();
  }
});

test("sem ASTRO_PROVIDER, exatamente um conjunto completo é usado", () => {
  expect(profileFromEnv(complete("openrouter"))?.id).toBe("openrouter");
});

test("dois conjuntos completos sem seletor é erro de ambiguidade", () => {
  const env = { ...complete("openai"), ...complete("nvidia") };
  expect(codeOf(() => profileFromEnv(env))).toBe("provider_env_ambiguous");
  const message = messageOf(() => profileFromEnv(env));
  expect(message).toContain("openai");
  expect(message).toContain("nvidia");
  expect(message).toContain("ASTRO_PROVIDER");
});

test("ASTRO_PROVIDER escolhe entre conjuntos completos, sem escolher outro", () => {
  const env = { ASTRO_PROVIDER: "nvidia", ...complete("openai"), ...complete("nvidia") };
  expect(profileFromEnv(env)?.id).toBe("nvidia");
  // Selecionar um conjunto incompleto não cai no conjunto completo do vizinho.
  expect(profileFromEnv({ ...env, ASTRO_PROVIDER: "openrouter" })).toBeUndefined();
  expect(profileFromEnv({ ...env, ASTRO_PROVIDER: "openrouter", ...complete("openrouter") })?.id).toBe("openrouter");
});

test("ASTRO_PROVIDER desconhecido é erro tipado com os nomes conhecidos", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-env-unknown-"));
  const env = { ASTRO_HOME: home, ASTRO_PROVIDER: "nao-existe", ...complete("openai") };
  const run = (): unknown => loadEffectiveConfig(join(home, "astro.config.json"), { env, allowMissing: true });
  expect(codeOf(run)).toBe("provider_unknown");
  const message = messageOf(run);
  expect(message).toContain('ASTRO_PROVIDER="nao-existe"');
  expect(message).toContain("openai");
  expect(readdirSync(home)).toEqual([]);
});

test("conjunto incompleto apontado pelo seletor falha citando a variável ausente", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-env-incomplete-"));
  const load = (extra: Record<string, string>): unknown => loadEffectiveConfig(join(home, "astro.config.json"), {
    env: { ASTRO_HOME: home, ASTRO_PROVIDER: "nvidia", ...complete("openai"), ...extra },
    allowMissing: true,
  });
  expect(codeOf(() => load({ NVIDIA_MODEL: "m" }))).toBe("provider_env_incomplete");
  expect(messageOf(() => load({ NVIDIA_MODEL: "m" }))).toContain("NVIDIA_API_KEY");
  expect(messageOf(() => load({ NVIDIA_API_KEY: "k" }))).toContain("NVIDIA_MODEL");
});

test("ASTRO_MODEL e ASTRO_BASE_URL não afetam mais a resolução", () => {
  const env = { ...complete("openai"), ASTRO_MODEL: "modelo-legado", ASTRO_BASE_URL: "https://legado.example/v1" };
  const profile = profileFromEnv(env)!;
  expect(profile.models[0]?.id).toBe("openai-modelo");
  expect(profile.baseUrl).toBe("https://api.openai.com/v1");
  expect(profileFromEnv({ OPENAI_API_KEY: "k", ASTRO_MODEL: "modelo-legado", ASTRO_BASE_URL: "https://legado.example/v1" })).toBeUndefined();
});

test("nada resolvido do ambiente é gravado em arquivo", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-env-nowrite-"));
  const key = "sk-sentinel-nao-gravar";
  const env = { ASTRO_HOME: join(dir, "home"), NVIDIA_API_KEY: key, NVIDIA_MODEL: "nvidia-modelo" };
  const effective = loadEffectiveConfig(join(dir, "astro.config.json"), { env, allowMissing: true });
  expect([effective.activeProvider, effective.providerSource, effective.providerSelection]).toEqual(["nvidia", "env", "env"]);
  expect(readdirSync(dir)).toEqual([]);
  expect(JSON.stringify(effective.config)).not.toContain(key);
  expect(JSON.stringify(effective.config)).toContain("NVIDIA_API_KEY");
});

test("http:// exige confirmação explícita; https:// não", () => {
  const insecure = { ...complete("openai"), OPENAI_BASE_URL: "http://api.openai.com/v1" };
  expect(codeOf(() => profileFromEnv(insecure))).toBe("provider_env_insecure_url");
  expect(profileFromEnv({ ...insecure, ASTRO_ALLOW_INSECURE_BASE_URL: "1" })?.baseUrl).toBe("http://api.openai.com/v1");
  expect(profileFromEnv({ ...complete("openai"), OPENAI_BASE_URL: "https://api.openai.com/v1" })?.baseUrl)
    .toBe("https://api.openai.com/v1");
});

test("perfil efêmero responde no providers health", async () => {
  const home = mkdtempSync(join(tmpdir(), "astro-env-health-"));
  const env = { ASTRO_HOME: home, ...complete("openrouter") };
  const effective = loadEffectiveConfig(join(home, "astro.config.json"), { env, allowMissing: true });
  const check = await testProvider(effective.config, "openrouter", env, {
    fetchLike: (async () => Response.json({ data: [] })) as unknown as typeof fetch,
    vault: { read: () => undefined },
  });
  expect(check.status).toBe("ok");
});

test("valor do ambiente não chega ao audit", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      choices: [{ message: { content: "oi" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "astro-env-audit-"));
    const key = "sk-audit-sentinel-nao-vaza";
    await runTask({
      configPath: join(dir, "astro.config.json"),
      cwd: dir,
      allowMissingConfig: true,
      task: "oi",
      env: {
        ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-audit-home-")),
        ASTRO_ALLOW_PRIVATE_URLS: "1",
        ASTRO_ALLOW_INSECURE_BASE_URL: "1",
        OPENAI_API_KEY: key,
        OPENAI_MODEL: "gpt-4o",
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      approveTool: () => true,
    });
    const audit = readFileSync(join(dir, ".astro", "audit.jsonl"), "utf8");
    expect(audit).toContain("run.started");
    expect(audit).not.toContain(key);
  } finally {
    server.stop(true);
  }
});

const PATHS = { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" };

function writeProject(dir: string, config: Record<string, unknown>): string {
  const path = join(dir, "astro.config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

/** Projeto que resolve o próprio provider + modelo (agent.model declarado). */
function resolvedProject(provider = "p"): Record<string, unknown> {
  return {
    providers: { [provider]: { kind: "openai-compat", baseUrl: `https://${provider}.example/v1`, credentialRef: "PROJECT_KEY" } },
    models: [{ provider, id: "project-model", tags: [], context: 8192 }],
    agent: { model: `${provider}/project-model`, maxSteps: 2, tools: ["read_file"] },
    paths: PATHS,
  };
}

test("config que resolve provider/modelo ignora os conjuntos do ambiente", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-env-resolved-"));
  const configPath = writeProject(dir, resolvedProject());
  const env = { ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-resolved-home-")), ...complete("openai"), ...complete("nvidia") };
  const effective = loadEffectiveConfig(configPath, { env });
  expect(effective.activeProvider).toBe("p");
  expect(effective.providerSelection).toBe("project");
  expect(effective.warnings.join(" ")).not.toContain("ambíguo");
  expect(effective.config.providers).not.toHaveProperty("openai");
  // `--provider` também funciona com dois conjuntos exportados.
  expect(loadEffectiveConfig(configPath, { env, provider: "p" }).activeProvider).toBe("p");
});

test("provider declarado vence o conjunto do mesmo id, sem misturar modelo e endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-env-declared-"));
  const configPath = writeProject(dir, {
    providers: { openai: { kind: "openai-compat", baseUrl: "https://project.example/v1", credentialRef: "PROJECT_KEY" } },
    models: [{ provider: "openai", id: "project-model", tags: [], context: 8192 }],
    paths: PATHS,
  });
  const env = {
    ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-declared-home-")),
    OPENAI_API_KEY: "env-key",
    OPENAI_MODEL: "env-model",
    OPENAI_BASE_URL: "https://env.example/v1",
  };
  const effective = loadEffectiveConfig(configPath, { env });
  expect(effective.activeProvider).toBe("openai");
  expect(effective.config.agent.model).toBe("openai/project-model");
  expect(effective.config.providers.openai?.baseUrl).toBe("https://project.example/v1");
  expect((effective.config.providers.openai as { credentialRef?: string }).credentialRef).toBe("PROJECT_KEY");
  expect(effective.config.models.map((model) => model.id)).not.toContain("env-model");
  expect(effective.envProviderId).toBeUndefined();
  expect(effective.providerSource).toBe("project");
});

test("seletor explícito com id declarado falha com provider_env_collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-env-collision-"));
  const configPath = writeProject(dir, {
    providers: { openai: { kind: "openai-compat", baseUrl: "https://project.example/v1", credentialRef: "PROJECT_KEY" } },
    models: [{ provider: "openai", id: "project-model", tags: [], context: 8192 }],
    paths: PATHS,
  });
  const env = {
    ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-collision-home-")),
    ASTRO_PROVIDER: "openai",
    OPENAI_API_KEY: "env-key",
    OPENAI_MODEL: "env-model",
  };
  const run = (): unknown => loadEffectiveConfig(configPath, { env });
  expect(codeOf(run)).toBe("provider_env_collision");
  expect(messageOf(run)).toContain('"openai"');
});

test("seletor com conjunto incompleto avisa e usa o provider configurado", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-env-warn-"));
  const configPath = writeProject(dir, resolvedProject("nvidia"));
  const env = { ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-warn-home-")), ASTRO_PROVIDER: "nvidia", NVIDIA_MODEL: "env-model" };
  const effective = loadEffectiveConfig(configPath, { env });
  expect(effective.activeProvider).toBe("nvidia");
  expect(effective.warnings.join(" ")).toContain("NVIDIA_* incompleto");
  expect(effective.warnings.join(" ")).toContain("NVIDIA_API_KEY");
});

test("ASTRO_PROVIDER é validado mesmo com --provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-env-validate-"));
  const configPath = writeProject(dir, resolvedProject());
  const env = { ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-validate-home-")), ASTRO_PROVIDER: "nao-existe" };
  expect(codeOf(() => loadEffectiveConfig(configPath, { env, provider: "p" }))).toBe("provider_unknown");
});

test("perfil salvo com id de conjunto não é sombreado e continua editável", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-env-stored-"));
  const storePath = join(home, "providers.json");
  saveProfileStore({
    version: 1,
    activeProfileId: "nvidia",
    profiles: [{
      id: "nvidia", name: "NVIDIA salvo", kind: "openai-compat",
      baseUrl: "https://saved.example/v1", credentialRef: "SAVED_KEY",
      models: [{ id: "saved-model", tags: [], context: 8192 }],
    }],
  }, storePath);
  const env = { ASTRO_HOME: home, NVIDIA_API_KEY: "env-key", NVIDIA_MODEL: "env-model" };
  const manager = new ProfileManager({ storePath, env });
  const view = manager.list().find((item) => item.id === "nvidia");
  expect(view?.source).toBe("global");
  expect(view?.baseUrl).toBe("https://saved.example/v1");
  // Renomear para o próprio id não é bloqueado pela reserva do ambiente.
  expect(() => manager.edit("nvidia", {
    name: "NVIDIA", kind: "openai-compat",
    baseUrl: "https://saved.example/v1", credentialRef: "SAVED_KEY",
    models: [{ id: "saved-model", tags: [], context: 8192 }],
  })).not.toThrow();
  const effective = loadEffectiveConfig(join(home, "astro.config.json"), { env, allowMissing: true, storePath });
  expect(effective.activeProvider).toBe("nvidia");
  expect(effective.config.providers.nvidia?.baseUrl).toBe("https://saved.example/v1");
  expect(effective.config.agent.model).toBe("nvidia/saved-model");
  expect(() => manager.remove("nvidia")).not.toThrow();
});

test("add e edit reservam os ids dos conjuntos de ambiente", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-env-reserved-"));
  const manager = new ProfileManager({
    env: {
      ASTRO_HOME: home,
      OPENAI_API_KEY: "k", OPENAI_MODEL: "m",
      NVIDIA_API_KEY: "k", NVIDIA_MODEL: "m",
      OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m",
    },
  });
  const draft = { kind: "openai-compat", baseUrl: "https://x.example/v1", credentialRef: "X_KEY", models: [{ id: "x", tags: [], context: 1000 }] };
  for (const name of ["OpenAI", "NVIDIA", "OpenRouter"]) {
    expect(() => manager.add({ name, ...draft })).toThrow(/reservado/);
  }
  // Sem o conjunto no ambiente o id não colide (o preset do catálogo continua salvando).
  const free = new ProfileManager({ env: { ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-env-free-")) } });
  const saved = free.add({ name: "NVIDIA", ...draft });
  expect(saved.id).toBe("nvidia");
  const created = manager.add({ name: "Work", ...draft });
  expect(() => manager.edit(created.id, { name: "openai", ...draft })).toThrow(/reservado/);
});

test("nenhuma mensagem de ProviderEnvError contém chave ou base URL", () => {
  const KEY = "sk-sentinel-nao-vazar";
  const HOST = "sentinel-base.example";
  const messages: string[] = [];
  const collect = (run: () => unknown): void => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof ProviderEnvError)) throw error;
      messages.push(error.message);
    }
  };
  collect(() => profileFromEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: "m", NVIDIA_API_KEY: KEY, NVIDIA_MODEL: "m" }));
  collect(() => profileFromEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: "m", OPENAI_BASE_URL: `http://${HOST}/v1` }));
  collect(() => resolveEffectiveConfig({ store: { version: 1, profiles: [] }, env: { ASTRO_PROVIDER: "nvidia", NVIDIA_API_KEY: KEY } }));
  collect(() => resolveEffectiveConfig({ store: { version: 1, profiles: [] }, env: { ASTRO_PROVIDER: "nao-existe" } }));
  collect(() => resolveEffectiveConfig({
    project: {
      providers: { openai: { kind: "openai-compat", baseUrl: `https://${HOST}/v1`, credentialRef: "PROJECT_KEY" } },
      models: [{ provider: "openai", id: "m", tags: [], context: 1000 }],
    },
    store: { version: 1, profiles: [] },
    env: { ASTRO_PROVIDER: "openai", OPENAI_API_KEY: KEY, OPENAI_MODEL: "env-model" },
  }));
  expect(messages.length).toBe(5);
  for (const message of messages) {
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(HOST);
  }
});