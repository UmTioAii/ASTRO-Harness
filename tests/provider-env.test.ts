import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEffectiveConfig, profileFromEnv } from "../src/providers/profiles";
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
