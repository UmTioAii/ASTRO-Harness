import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  loadConfig,
  validateConfig,
  type AstroConfig,
} from "../src/core/config";
import { migrateConfigFile } from "../src/core/config-migrate";
import { validateProjectLayer } from "../src/providers/profiles";

// Sentinelas montados em runtime para não disparar o gate de segredos.
const SENTINEL = ["sentinel", "-", "nao", "-", "vaza"].join("");

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: {
      mock: { kind: "openai-compat", baseUrl: "http://localhost:1234/v1", credentialRef: "TEST_KEY" },
    },
    models: [{ provider: "mock", id: "m1", tags: ["writing-code"], context: 4096 }],
    agent: { model: "mock/m1", maxSteps: 3, tools: [] },
    ...extra,
  };
}

function tempConfig(raw: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-config-schema-"));
  const path = join(dir, "astro.config.json");
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  return path;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).code;
  }
  throw new Error("esperava ConfigError");
}

describe("ADR-0028 versão do schema", () => {
  test("versão suportada é aceita e preservada", () => {
    const config: AstroConfig = validateConfig(base({ version: CONFIG_SCHEMA_VERSION }));
    expect(config.version).toBe(CONFIG_SCHEMA_VERSION);
    expect(CONFIG_SCHEMA_VERSION.split(".")[0]).toBe("1");
  });

  test("versão ausente é legado aceito: version undefined e migratedFrom 0.0.0", () => {
    const config = validateConfig(base());
    expect(config.version).toBeUndefined();
    expect(config.migratedFrom).toBe("0.0.0");
  });

  test("versão antiga explícita é migrada em memória e mantém a origem", () => {
    const config = validateConfig(base({ version: "0.4.2" }));
    expect(config.version).toBe("0.4.2");
    expect(config.migratedFrom).toBe("0.4.2");
  });

  test("major à frente recusa antes de qualquer checagem de chave", () => {
    const raw = base({ version: "2.0.0", chaveInventada: true });
    let caught: unknown;
    try {
      validateConfig(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("config_ahead_of_harness");
    const message = (caught as Error).message;
    expect(message).toContain("2.0.0");
    expect(message).not.toContain("chaveInventada");
  });

  test("loadConfig nomeia o arquivo e a versão na recusa", () => {
    const path = tempConfig(base({ version: "3.1.0" }));
    let caught: unknown;
    try {
      loadConfig(path);
    } catch (error) {
      caught = error;
    }
    expect((caught as ConfigError).code).toBe("config_ahead_of_harness");
    const message = (caught as Error).message;
    expect(message).toContain(path);
    expect(message).toContain("3.1.0");
  });

  test("minor à frente do suportado é aceito (só dica, não decide aceite)", () => {
    const [major] = CONFIG_SCHEMA_VERSION.split(".");
    expect(() => validateConfig(base({ version: `${major}.9.0` }))).not.toThrow();
  });

  test("formato de version inválido falha sem ecoar o valor cru", () => {
    let caught: unknown;
    try {
      validateConfig(base({ version: SENTINEL }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("config_invalid_schema");
    const message = (caught as Error).message;
    expect(message).toContain("semver");
    expect(message).not.toContain(SENTINEL);
  });

  test("chave desconhecida em seção de forma fixa falha com config_unknown_key", () => {
    const raw = base({
      version: CONFIG_SCHEMA_VERSION,
      agent: { model: "mock/m1", maxSteps: 3, tools: [], maxStep: 3 },
    });
    expect(codeOf(() => validateConfig(raw))).toBe("config_unknown_key");
    let caught: unknown;
    try {
      validateConfig(raw);
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error).message;
    expect(message).toContain("agent.maxStep");
    expect(message).toContain("astro config migrate");
    expect(message).toMatch(/major 1/);
  });

  test("chave desconhecida no topo falha com config_unknown_key", () => {
    expect(codeOf(() => validateConfig(base({ agnet: {}, version: CONFIG_SCHEMA_VERSION }))))
      .toBe("config_unknown_key");
  });

  test("config legada sem version também rejeita typo no topo (destino é o major suportado)", () => {
    expect(codeOf(() => validateConfig(base({ agnet: {} })))).toBe("config_unknown_key");
  });

  test("contêineres de nome livre aceitam nomes arbitrários e o valor continua forma fixa", () => {
    const raw = base({
      version: CONFIG_SCHEMA_VERSION,
      providers: {
        "provider-livre": { kind: "openai-compat", baseUrl: "http://localhost:1234/v1", credentialRef: "TEST_KEY" },
        outro: { kind: "openai-compat", baseUrl: "http://localhost:1234/v1", credentialRef: "OUTRA_KEY" },
      },
      models: [{ provider: "provider-livre", id: "m1", tags: ["writing-code"], context: 4096 }],
      agent: { model: "provider-livre/m1", maxSteps: 3, tools: [], entryAgent: "planejador-livre" },
      agents: { "agente-livre": { model: "provider-livre/m1", tools: [] } },
      quota: { "dominio-livre": { dailyTokens: 10 } },
      mcpServers: { "servidor-livre": { transport: "stdio", command: "stub", timeoutMs: 1000, enabled: false } },
    });
    expect(() => validateConfig(raw)).not.toThrow();
    // O valor do contêiner de nome livre segue forma fixa.
    const broken = base({
      version: CONFIG_SCHEMA_VERSION,
      quota: { "dominio-livre": { dailyToken: 10 } },
    });
    expect(codeOf(() => validateConfig(broken))).toBe("config_unknown_key");
  });

  test("provider de plugin mantém shape opaco", () => {
    const raw = {
      version: CONFIG_SCHEMA_VERSION,
      providers: { plug: { kind: "kind-externo", qualquerCoisa: { a: 1 } } },
      models: [{ provider: "plug", id: "m1", tags: [], context: 1024 }],
      agent: { model: "plug/m1", maxSteps: 1, tools: [] },
    };
    expect(() => validateConfig(raw)).not.toThrow();
  });

  test("$schema e provenance são metadados validados e nunca viram config", () => {
    const raw = base({
      version: CONFIG_SCHEMA_VERSION,
      $schema: "https://example.invalid/astro.schema.json",
      provenance: { registry: "org/repo", plugins: false },
    });
    expect(() => validateConfig(raw)).not.toThrow();
    expect(codeOf(() => validateConfig(base({ version: CONFIG_SCHEMA_VERSION, provenance: "texto" }))))
      .toBe("config_invalid_schema");
    expect(codeOf(() => validateConfig(base({ version: CONFIG_SCHEMA_VERSION, $schema: 42 }))))
      .toBe("config_invalid_schema");
  });
});

describe("astro config migrate (ADR-0028)", () => {
  test("dry-run é o default e não grava nada", () => {
    const path = tempConfig(base({ $schema: "https://example.invalid/s.json", agent: { model: "mock/m1", maxSteps: 3, tools: [], systemPrompt: SENTINEL } }));
    const before = readFileSync(path, "utf8");
    const report = migrateConfigFile(path, { apply: false });
    expect(report.written).toBe(false);
    expect(report.alreadyCurrent).toBe(false);
    expect(report.declaredVersion).toBe("0.0.0");
    expect(report.targetVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(readFileSync(path, "utf8")).toBe(before);
    const lines = report.lines.join("\n");
    expect(lines).toContain("--apply");
    expect(lines).toContain(CONFIG_SCHEMA_VERSION);
    expect(lines).not.toContain(SENTINEL);
  });

  test("--apply grava uma vez, atômico, preservando conteúdo e sem default permissivo", () => {
    const path = tempConfig(base({
      $schema: "https://example.invalid/s.json",
      provenance: { registry: "org/repo", plugins: true },
      permissions: { mode: "ask" },
      tools: { run_command: { sandbox: true } },
      budget: { scope: "month", limitUsd: 10 },
      providers: {
        mock: { kind: "openai-compat", baseUrl: "http://localhost:1234/v1", credentialRef: "TEST_KEY" },
        "provider-livre": { kind: "openai-compat", baseUrl: "http://localhost:1234/v1", credentialRef: "OUTRA_KEY" },
      },
    }));
    const report = migrateConfigFile(path, { apply: true });
    expect(report.written).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.version).toBe(CONFIG_SCHEMA_VERSION);
    expect(written.$schema).toBe("https://example.invalid/s.json");
    expect(written.provenance).toEqual({ registry: "org/repo", plugins: true });
    expect(written.permissions).toEqual({ mode: "ask" });
    expect(written.tools).toEqual({ run_command: { sandbox: true } });
    expect(written.budget).toEqual({ scope: "month", limitUsd: 10 });
    expect(Object.keys(written.providers as object)).toContain("provider-livre");
    // Nada de budget/permissions injetados quando a origem não declara.
    expect(() => validateConfig(written)).not.toThrow();
  });

  test("versão de major anterior com minor/patch é carimbada no major suportado", () => {
    const path = tempConfig(base({ version: "0.4.2" }));
    const report = migrateConfigFile(path, { apply: true });
    expect(report.declaredVersion).toBe("0.4.2");
    expect(report.written).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version).toBe(CONFIG_SCHEMA_VERSION);
  });

  test("segunda execução é no-op (idempotente)", () => {
    const path = tempConfig(base());
    expect(migrateConfigFile(path, { apply: true }).written).toBe(true);
    const after = readFileSync(path, "utf8");
    const second = migrateConfigFile(path, { apply: true });
    expect(second.written).toBe(false);
    expect(second.alreadyCurrent).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(after);
  });

  test("arquivo já no schema suportado não é reescrito", () => {
    const path = tempConfig(base({ version: CONFIG_SCHEMA_VERSION }));
    const before = readFileSync(path, "utf8");
    const report = migrateConfigFile(path, { apply: true });
    expect(report.written).toBe(false);
    expect(report.alreadyCurrent).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("versão mais nova falha fechado e deixa o arquivo intacto", () => {
    const path = tempConfig(base({ version: "9.0.0" }));
    const before = readFileSync(path, "utf8");
    expect(codeOf(() => migrateConfigFile(path, { apply: true }))).toBe("config_ahead_of_harness");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("entrada inválida falha tipado e não grava", () => {
    const path = tempConfig(base({ agnet: {}, version: CONFIG_SCHEMA_VERSION }));
    const before = readFileSync(path, "utf8");
    expect(codeOf(() => migrateConfigFile(path, { apply: true }))).toBe("config_unknown_key");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("config de projeto incompleta não é gravada (validação sempre)", () => {
    const path = tempConfig({ version: CONFIG_SCHEMA_VERSION, agent: { maxSteps: 1 } });
    const before = readFileSync(path, "utf8");
    expect(() => migrateConfigFile(path, { apply: true })).toThrow(ConfigError);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("camada global parcial migra e preserva o conteúdo", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-config-migrate-home-"));
    const path = join(home, "config.json");
    writeFileSync(path, JSON.stringify({
      activeProfileId: "g",
      providers: { g: { kind: "openai-compat", baseUrl: "https://g.example/v1", credentialRef: "KEY" } },
    }));
    const report = migrateConfigFile(path, { apply: true, env: { ASTRO_HOME: home } });
    expect(report.written).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.version).toBe(CONFIG_SCHEMA_VERSION);
    expect(written.activeProfileId).toBe("g");
    expect(Object.keys(written.providers as object)).toEqual(["g"]);
    expect(migrateConfigFile(path, { apply: true, env: { ASTRO_HOME: home } }).written).toBe(false);
  });

  test.skipIf(process.platform === "win32")("destino symlink é recusado e o alvo fica intacto", () => {
    const target = tempConfig(base());
    const dir = mkdtempSync(join(tmpdir(), "astro-config-schema-link-"));
    const link = join(dir, "astro.config.json");
    symlinkSync(target, link);
    const before = readFileSync(target, "utf8");
    expect(codeOf(() => migrateConfigFile(link, { apply: true }))).toBe("config_write_denied");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(existsSync(target)).toBe(true);
  });
});

describe("ADR-0028 nas duas camadas (global e projeto)", () => {
  function envFor(home: string): NodeJS.ProcessEnv {
    return { ASTRO_HOME: home };
  }

  test("camada global mais nova falha fechado nomeando o arquivo global", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-config-schema-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: "7.0.0" }));
    let caught: unknown;
    try {
      validateProjectLayer(base(), envFor(home));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("config_ahead_of_harness");
    expect((caught as Error).message).toContain(join(home, "config.json"));
    expect((caught as Error).message).toContain("7.0.0");
  });

  test("chave desconhecida na camada global falha com config_unknown_key", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-config-schema-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ versao: "1.0.0" }));
    expect(codeOf(() => validateProjectLayer(base(), envFor(home)))).toBe("config_unknown_key");
  });

  test("camada global legada (sem version) continua aceita", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-config-schema-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: { global: { kind: "openai-compat", baseUrl: "http://localhost:1234/v1", credentialRef: "TEST_KEY" } },
      models: [{ provider: "global", id: "m2", tags: ["writing-code"], context: 2048 }],
    }));
    const merged = validateProjectLayer(base(), envFor(home));
    expect(Object.keys(merged.providers)).toContain("global");
    expect(merged.version).toBeUndefined();
  });
});

describe("astro config migrate na CLI", () => {
  const entry = join(import.meta.dir, "..", "src", "cli.ts");

  function run(args: string[], home: string) {
    return Bun.spawn([process.execPath, entry, "config", "migrate", ...args], {
      env: { ...process.env, ASTRO_HOME: home, ASTRO_NO_GLOBAL_CONFIG: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("dry-run sai 0, imprime a versão e não grava", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-migrate-cli-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, `${JSON.stringify(base(), null, 2)}\n`);
    const before = readFileSync(path, "utf8");
    const proc = run(["--config", path], dir);
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain(CONFIG_SCHEMA_VERSION);
    expect(err).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("--apply grava o novo version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-migrate-cli-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, JSON.stringify(base()));
    const proc = run(["--config", path, "--apply"], dir);
    expect(await new Response(proc.stdout).text()).toContain(CONFIG_SCHEMA_VERSION);
    expect(await proc.exited).toBe(0);
    expect((JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version).toBe(CONFIG_SCHEMA_VERSION);
  });

  test("versão mais nova na CLI sai diferente de 0 com código tipado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-config-migrate-cli-"));
    const path = join(dir, "astro.config.json");
    writeFileSync(path, JSON.stringify(base({ version: "9.0.0" })));
    const proc = run(["--config", path, "--apply"], dir);
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain("config_ahead_of_harness");
  });
});
