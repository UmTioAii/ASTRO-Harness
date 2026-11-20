/** First-run da TUI: cria astro.config.json + config.json global se ausentes (#559). */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as init from "../src/chat/init";
import { loadProjectConfig } from "../src/providers/profiles";
import { updateConfigKnobs } from "../src/core/config-edit";
import { globalConfigPath } from "../src/astro-home";

// RED: a API ainda não existe — o cast estrutural mantém o typecheck limpo e
// os testes falham em runtime (ensureFirstRunConfig === undefined).
interface FirstRunApi {
  ensureFirstRunConfig?: (
    configPath: string,
    opts?: { env?: NodeJS.ProcessEnv; allowMissing?: boolean },
  ) => { projectCreated: boolean; globalCreated: boolean };
  GLOBAL_CONFIG_TEMPLATE?: string;
}
const api = init as unknown as FirstRunApi;

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

const GLOBAL_WITH_PROVIDER = JSON.stringify({
  providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  activeProfileId: "p",
});

describe("ensureFirstRunConfig — first-run da TUI cria as configs (#559)", () => {
  test("projeto sem config + global com provider: cria astro.config.json com agent.model do perfil ativo", () => {
    const cwd = tempDir("astro-first-run-");
    const home = tempDir("astro-first-home-");
    writeFileSync(join(home, "config.json"), GLOBAL_WITH_PROVIDER);
    const globalBefore = readFileSync(join(home, "config.json"), "utf8");
    const configPath = join(cwd, "astro.config.json");
    expect(api.ensureFirstRunConfig).toBeTypeOf("function"); // RED: ainda não existe
    const result = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(result).toEqual({ projectCreated: true, globalCreated: false });
    expect(existsSync(configPath)).toBe(true);
    // template mínimo e válido no merge: só agent.model apontando para o modelo global
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ agent: { model: "p/m1" } });
    expect(loadProjectConfig(configPath, { env: { ASTRO_HOME: home } })?.agent.model).toBe("p/m1");
    // global pré-existente não é tocado
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(globalBefore);
    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o777).toBe(0o600); // astro.config.json é HARD_BLOCK
    }
  });

  test("first-run total (sem global): cria só o config.json global; o projeto espera o setup", () => {
    const cwd = tempDir("astro-first-total-");
    const home = tempDir("astro-first-total-home-");
    const configPath = join(cwd, "astro.config.json");
    const result = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(result).toEqual({ projectCreated: false, globalCreated: true });
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(globalConfigPath({ ASTRO_HOME: home }), "utf8"))).toEqual(
      JSON.parse(api.GLOBAL_CONFIG_TEMPLATE!),
    );
    expect(existsSync(configPath)).toBe(false); // sem provider não dá para gravar config de projeto válida
    if (process.platform !== "win32") {
      expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    }
    // depois do setup (global passa a ter provider), a mesma chamada cria o projeto
    writeFileSync(join(home, "config.json"), GLOBAL_WITH_PROVIDER);
    const again = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(again).toEqual({ projectCreated: true, globalCreated: false });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ agent: { model: "p/m1" } });
  });

  test("arquivos pré-existentes ficam byte a byte intactos e nada é recriado", () => {
    const cwd = tempDir("astro-first-keep-");
    const home = tempDir("astro-first-home-keep-");
    const configPath = join(cwd, "astro.config.json");
    const globalPath = join(home, "config.json");
    writeFileSync(configPath, '{"agent":{"maxSteps":7}}', "utf8");
    writeFileSync(globalPath, GLOBAL_WITH_PROVIDER, "utf8");
    const result = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(result).toEqual({ projectCreated: false, globalCreated: false });
    expect(readFileSync(configPath, "utf8")).toBe('{"agent":{"maxSteps":7}}');
    expect(readFileSync(globalPath, "utf8")).toBe(GLOBAL_WITH_PROVIDER);
  });

  test("config explícita (allowMissing=false) não cria nenhum arquivo", () => {
    const cwd = tempDir("astro-first-explicit-");
    const home = tempDir("astro-first-home-explicit-");
    const configPath = join(cwd, "custom.json");
    const result = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: false });
    expect(result).toEqual({ projectCreated: false, globalCreated: false });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("ASTRO_NO_GLOBAL_CONFIG=1 nunca cria o global (e sem camada global não há projeto válido)", () => {
    const cwd = tempDir("astro-first-noglobal-");
    const home = tempDir("astro-first-home-noglobal-");
    const configPath = join(cwd, "astro.config.json");
    const result = api.ensureFirstRunConfig!(configPath, {
      env: { ASTRO_HOME: home, ASTRO_NO_GLOBAL_CONFIG: "1" },
      allowMissing: true,
    });
    expect(result).toEqual({ projectCreated: false, globalCreated: false });
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  test("após criar, /config persiste no arquivo novo (grava de primeira, via merge com o global)", () => {
    const cwd = tempDir("astro-first-persist-");
    const home = tempDir("astro-first-home-persist-");
    writeFileSync(join(home, "config.json"), GLOBAL_WITH_PROVIDER);
    const configPath = join(cwd, "astro.config.json");
    api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    updateConfigKnobs(configPath, { "permissions.mode": "allow-edits" }, { env: { ASTRO_HOME: home } });
    expect(loadProjectConfig(configPath, { env: { ASTRO_HOME: home } })?.permissions.mode).toBe("allow-edits");
  });
});
