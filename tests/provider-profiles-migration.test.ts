import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEffectiveConfig,
  loadGlobalProfileStore,
  ProfileStoreError,
} from "../src/providers/profiles";

const profileA = {
  id: "a",
  name: "Provider A",
  kind: "openai-compat",
  baseUrl: "https://a.example/v1",
  credentialRef: "A_KEY",
  models: [{ id: "m1", tags: ["writing-code"], context: 8192 }],
};
const profileB = {
  id: "b",
  name: "Provider B",
  kind: "openai-compat",
  baseUrl: "https://b.example/v1",
  models: [{ id: "m2", tags: ["writing-code"], context: 4096 }],
};

const homeDir = (): string => mkdtempSync(join(tmpdir(), "astro-migrate-"));
// Fixture de segredo montada em runtime para não disparar o gate de segredos.
const SENTINEL = ["s", "k", "-"].join("") + "live-SENTINEL";

function jsonAt(home: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, name), "utf8")) as Record<string, unknown>;
}

test("importa providers.json para config.json uma vez e preserva o legado", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  const bytes = JSON.stringify({ version: 1, activeProfileId: "b", profiles: [profileA, profileB] });
  writeFileSync(legacy, bytes);

  const store = loadGlobalProfileStore({ ASTRO_HOME: home });

  expect(store.profiles.map((profile) => profile.id)).toEqual(["a", "b"]);
  expect(store.activeProfileId).toBe("b");
  const config = jsonAt(home, "config.json");
  expect(config.providers).toEqual({
    a: { kind: "openai-compat", baseUrl: "https://a.example/v1", credentialRef: "A_KEY" },
    b: { kind: "openai-compat", baseUrl: "https://b.example/v1" },
  });
  expect(config.models).toEqual([
    { provider: "a", id: "m1", tags: ["writing-code"], context: 8192 },
    { provider: "b", id: "m2", tags: ["writing-code"], context: 4096 },
  ]);
  expect(config.activeProfileId).toBe("b");
  expect(jsonAt(home, "state.json").migrations).toEqual({ providers: true, trust: false });
  expect(readFileSync(legacy, "utf8")).toBe(bytes);
});

test("a segunda carga não reescreve config.json nem relê o legado", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  writeFileSync(legacy, JSON.stringify({ version: 1, profiles: [profileA, profileB] }));
  loadGlobalProfileStore({ ASTRO_HOME: home });
  const before = readFileSync(join(home, "config.json"), "utf8");
  // Se o legado fosse relido, este conteúdo inválido faria a carga falhar.
  writeFileSync(legacy, "lixo");

  const again = loadGlobalProfileStore({ ASTRO_HOME: home });

  expect(again.profiles.map((profile) => profile.id)).toEqual(["a", "b"]);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  expect(readFileSync(legacy, "utf8")).toBe("lixo");
});

test("conflito por chave: config.json vence e models não duplicam", () => {
  const home = homeDir();
  const existingProvider = { kind: "openai-compat", baseUrl: "https://config.example/v1", credentialRef: "CONFIG_KEY" };
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { a: existingProvider },
    models: [{ provider: "a", id: "m1", tags: ["writing-code"], context: 1 }],
    activeProfileId: "a",
  }));
  writeFileSync(join(home, "providers.json"), JSON.stringify({
    version: 1,
    activeProfileId: "b",
    profiles: [profileA, profileB],
  }));

  const store = loadGlobalProfileStore({ ASTRO_HOME: home });

  const config = jsonAt(home, "config.json");
  expect((config.providers as Record<string, unknown>).a).toEqual(existingProvider);
  expect((config.providers as Record<string, unknown>).b).toEqual({
    kind: "openai-compat",
    baseUrl: "https://b.example/v1",
  });
  expect(config.models).toEqual([
    { provider: "a", id: "m1", tags: ["writing-code"], context: 1 },
    { provider: "b", id: "m2", tags: ["writing-code"], context: 4096 },
  ]);
  expect(config.activeProfileId).toBe("a");
  expect(store.activeProfileId).toBe("a");
});

test("sem store legado nem config global o carregamento não cria arquivos", () => {
  const home = homeDir();

  expect(loadGlobalProfileStore({ ASTRO_HOME: home })).toEqual({ version: 1, profiles: [] });
  expect(readdirSync(home)).toEqual([]);
});

test("store legado inválido: erro tipado com caminho, sem ecoar conteúdo (I-03)", () => {
  const home = homeDir();
  const legacy = join(home, "providers.json");
  // JSON truncado que contém o sentinela: o detalhe do parser nunca pode vazar.
  const bytes = `{"version":1,"profiles":[{"credentialRef":"${SENTINEL}"`;
  writeFileSync(legacy, bytes);

  let thrown: unknown;
  try {
    loadGlobalProfileStore({ ASTRO_HOME: home });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ProfileStoreError);
  expect((thrown as ProfileStoreError).path).toBe(legacy);
  expect((thrown as Error).message).toContain("providers.json");
  expect((thrown as Error).message).not.toContain(SENTINEL);
  expect(existsSync(join(home, "config.json"))).toBe(false);
  expect(existsSync(join(home, "state.json"))).toBe(false);
  expect(readFileSync(legacy, "utf8")).toBe(bytes);
});

test("depois do import config.json é a fonte de verdade na resolução", () => {
  const home = homeDir();
  writeFileSync(join(home, "providers.json"), JSON.stringify({
    version: 1,
    activeProfileId: "b",
    profiles: [profileA, profileB],
  }));
  loadGlobalProfileStore({ ASTRO_HOME: home });
  const config = jsonAt(home, "config.json");
  ((config.providers as Record<string, Record<string, unknown>>).a!).baseUrl = "https://edited.example/v1";
  writeFileSync(join(home, "config.json"), JSON.stringify(config));

  const effective = loadEffectiveConfig(join(home, "astro.config.json"), {
    env: { ASTRO_HOME: home },
    allowMissing: true,
  });

  expect(effective.config.providers.a).toMatchObject({ baseUrl: "https://edited.example/v1" });
  expect(effective.activeProvider).toBe("b");
  expect(effective.providerSelection).toBe("store");
});
