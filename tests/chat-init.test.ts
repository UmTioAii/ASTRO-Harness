/** First-run da TUI: cria astro.config.json + config.json global se ausentes (#559). */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as init from "../src/chat/init";
import { loadConfig } from "../src/core/config";
import { globalConfigPath } from "../src/astro-home";

// RED: a API ainda não existe — o cast estrutural mantém o typecheck limpo e
// os testes falham em runtime (ensureFirstRunConfig === undefined).
interface FirstRunApi {
  ensureFirstRunConfig?: (
    configPath: string,
    opts?: { env?: NodeJS.ProcessEnv; allowMissing?: boolean },
  ) => { projectCreated: boolean; globalCreated: boolean };
  PROJECT_CONFIG_TEMPLATE?: string;
}
const api = init as unknown as FirstRunApi;

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

describe("ensureFirstRunConfig — first-run da TUI cria as configs (#559)", () => {
  test("dir nova com config implícita: cria astro.config.json e o config.json global juntos", () => {
    const cwd = tempDir("astro-first-run-");
    const home = tempDir("astro-first-home-");
    const configPath = join(cwd, "astro.config.json");
    expect(api.ensureFirstRunConfig).toBeTypeOf("function"); // RED: ainda não existe
    const result = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(result).toEqual({ projectCreated: true, globalCreated: true });
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(globalConfigPath({ ASTRO_HOME: home }))).toBe(true);
    // o template é uma config válida (carrega) e não contém segredos (só estrutura vazia)
    expect(loadConfig(configPath)).toBeDefined();
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(globalConfigPath({ ASTRO_HOME: home }), "utf8"))).toEqual({});
    expect(api.PROJECT_CONFIG_TEMPLATE).toBe(readFileSync(configPath, "utf8"));
    if (process.platform !== "win32") {
      expect(statSync(configPath).mode & 0o777).toBe(0o600); // astro.config.json é HARD_BLOCK
      expect(statSync(globalConfigPath({ ASTRO_HOME: home })).mode & 0o777).toBe(0o600);
    }
  });

  test("arquivos pré-existentes ficam byte a byte intactos e nada é recriado", () => {
    const cwd = tempDir("astro-first-keep-");
    const home = tempDir("astro-first-home-keep-");
    const configPath = join(cwd, "astro.config.json");
    const globalPath = join(home, "config.json");
    writeFileSync(configPath, '{"agent":{"maxSteps":7}}', "utf8");
    writeFileSync(globalPath, '{"providers":{}}', "utf8");
    const result = api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(result).toEqual({ projectCreated: false, globalCreated: false });
    expect(readFileSync(configPath, "utf8")).toBe('{"agent":{"maxSteps":7}}');
    expect(readFileSync(globalPath, "utf8")).toBe('{"providers":{}}');
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

  test("ASTRO_NO_GLOBAL_CONFIG=1 cria só o projeto, nunca o global", () => {
    const cwd = tempDir("astro-first-noglobal-");
    const home = tempDir("astro-first-home-noglobal-");
    const configPath = join(cwd, "astro.config.json");
    const result = api.ensureFirstRunConfig!(configPath, {
      env: { ASTRO_HOME: home, ASTRO_NO_GLOBAL_CONFIG: "1" },
      allowMissing: true,
    });
    expect(result).toEqual({ projectCreated: true, globalCreated: false });
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("após criar, /config persiste no arquivo novo (modo grava de primeira)", () => {
    const cwd = tempDir("astro-first-persist-");
    const home = tempDir("astro-first-home-persist-");
    const configPath = join(cwd, "astro.config.json");
    api.ensureFirstRunConfig!(configPath, { env: { ASTRO_HOME: home }, allowMissing: true });
    // mesma escrita que savePermissionMode usa: o arquivo criado tem de aceitar update
    const { updateConfigPermissionsMode } = require("../src/core/config") as typeof import("../src/core/config");
    updateConfigPermissionsMode(configPath, "allow-edits");
    expect(loadConfig(configPath).permissions.mode).toBe("allow-edits");
  });
});
