import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, type AstroConfig } from "../src/core/config";
import { ProfileManager, type ProfileDraft } from "../src/providers/profile-manager";
import { loadProfileStore, profileStoreFromConfig, saveProfileStore } from "../src/providers/profiles";

function project(): AstroConfig {
  return validateConfig({
    providers: {
      p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" },
    },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

const draft = (over: Partial<ProfileDraft> = {}): ProfileDraft => ({
  name: "OpenAI Work",
  kind: "openai-compat",
  baseUrl: "https://api.openai.com/v1",
  credentialRef: "OPENAI_API_KEY",
  models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
  ...over,
});

function manager(home = mkdtempSync(join(tmpdir(), "astro-mgr-")), env: NodeJS.ProcessEnv = {}) {
  return {
    home,
    m: new ProfileManager({ project: project(), env: { ASTRO_HOME: home, ...env } }),
  };
}

const storeAt = (home: string) => profileStoreFromConfig(join(home, "config.json"));

test("add grava no store e não ativa", () => {
  const { home, m } = manager();
  const view = m.add(draft());
  expect(view.id).toBe("openai-work");
  expect(view.active).toBe(false);
  expect(view.source).toBe("global");
  const store = storeAt(home);
  expect(store.profiles.map((item) => item.id)).toEqual(["openai-work"]);
  expect(store.activeProfileId).toBeUndefined();
});

test("add rejeita nome duplicado", () => {
  const { m } = manager();
  m.add(draft());
  expect(() => m.add(draft({ baseUrl: "https://other.example/v1" })))
    .toThrow(/já existe um provider com esse nome/);
});

test("add rejeita nome de provider do projeto", () => {
  const { m } = manager();
  expect(() => m.add(draft({ name: "p" }))).toThrow(/astro\.config\.json/);
  expect(() => m.add(draft({ name: "P" }))).toThrow(/astro\.config\.json/);
});

test("add aceita provider sem chave", () => {
  const { home, m } = manager();
  const view = m.add(draft({ name: "Ollama", credentialRef: undefined, baseUrl: "http://localhost:11434/v1" }));
  expect(view.credentialRef).toBeUndefined();
  expect(storeAt(home).profiles[0]!.credentialRef).toBeUndefined();
});

test("edit mantém o id e atualiza os campos", () => {
  const { m } = manager();
  const added = m.add(draft());
  const edited = m.edit(added.id, draft({ name: "OpenAI Work 2", baseUrl: "https://proxy.example/v1" }));
  expect(edited.id).toBe(added.id);
  expect(edited.name).toBe("OpenAI Work 2");
  expect(edited.baseUrl).toBe("https://proxy.example/v1");
});

test("edit rejeita provider do projeto", () => {
  const { m } = manager();
  expect(() => m.edit("p", draft({ name: "p" }))).toThrow(/astro\.config\.json/);
});

test("remove apaga do store", () => {
  const { home, m } = manager();
  const added = m.add(draft());
  m.remove(added.id);
  expect(storeAt(home).profiles).toEqual([]);
});

test("remove do ativo limpa activeProfileId", () => {
  const { home, m } = manager();
  const added = m.add(draft());
  m.use(added.id);
  expect(storeAt(home).activeProfileId).toBe(added.id);
  m.remove(added.id);
  expect(storeAt(home).activeProfileId).toBeUndefined();
});

test("remove rejeita provider do projeto", () => {
  const { m } = manager();
  expect(() => m.remove("p")).toThrow(/astro\.config\.json/);
});

test("nome de exibição faz round-trip e um manager novo edita/remove (#492)", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-name-"));
  const a = new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
  const added = a.add(draft({ name: "Casa" }));
  expect(added.id).toBe("casa");
  const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    providers: Record<string, { name?: string }>;
  };
  expect(raw.providers.casa?.name).toBe("Casa"); // rótulo persistido no config.json

  const b = new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
  expect(b.list().find((item) => item.id === "casa")?.name).toBe("Casa");
  b.use("casa");
  const edited = b.edit("casa", draft({ name: "Casa 2" }));
  expect(edited.name).toBe("Casa 2");
  const c = new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
  expect(c.list().find((item) => item.id === "casa")?.name).toBe("Casa 2");
  // Voltar o rótulo ao id remove o `name` antigo em vez de mantê-lo (revisão #492).
  c.edit("casa", draft({ name: "casa" }));
  const reset = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    providers: Record<string, { name?: string }>;
  };
  expect(reset.providers.casa?.name).toBeUndefined();
  expect(() => c.remove("casa")).not.toThrow(); // novo manager pode remover o que o CRUD criou
});

test("provider com modelo editado à mão sem tags não é apagado pelo CRUD (#492)", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-hand-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: { hand: { kind: "openai-compat", baseUrl: "https://hand.example/v1" } },
    models: [{ provider: "hand", id: "h1" }], // sem tags/context: fora do store
  }));
  const m = new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
  m.add(draft());
  const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    providers: Record<string, unknown>;
    models: Array<{ provider: string; id: string }>;
  };
  expect(raw.providers.hand).toBeDefined(); // não foi tratado como removido pelo CRUD
  expect(raw.models.some((model) => model.provider === "hand" && model.id === "h1")).toBe(true);
});

test("add, use e remove gravam em config.json e preservam chaves alheias (#492)", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-global-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    permissions: { mode: "ask" },
    budget: { limitUsd: 5 },
    providers: { keep: { kind: "openai-compat", baseUrl: "https://keep.example/v1", timeoutMs: 5000 } },
    models: [{ provider: "keep", id: "k1", tags: ["fast"], context: 4096, price: { inputPerM: 1, outputPerM: 1 } }],
  }));
  const m = new ProfileManager({ project: project(), env: { ASTRO_HOME: home } });
  const added = m.add(draft());
  m.use(added.id);
  const afterAdd = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
  expect(afterAdd.permissions).toEqual({ mode: "ask" }); // chave alheia intacta
  expect(afterAdd.budget).toEqual({ limitUsd: 5 });
  expect((afterAdd.providers as Record<string, unknown>).keep).toEqual({
    kind: "openai-compat", baseUrl: "https://keep.example/v1", timeoutMs: 5000,
  }); // campo extra do provider preservado
  expect(afterAdd.activeProfileId).toBe(added.id);
  const models = afterAdd.models as Array<Record<string, unknown>>;
  expect(models.find((model) => model.provider === "keep")).toMatchObject({ price: { inputPerM: 1, outputPerM: 1 } });

  m.remove(added.id);
  const afterRemove = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
  expect((afterRemove.providers as Record<string, unknown>)[added.id]).toBeUndefined();
  expect((afterRemove.models as Array<Record<string, unknown>>).some((model) => model.provider === added.id)).toBe(false);
  expect((afterRemove.providers as Record<string, unknown>).keep).toBeDefined();
  expect(afterRemove.activeProfileId).toBeUndefined();
  expect(existsSync(join(home, "providers.json"))).toBe(false); // legado nunca é escrito
});

test("use persiste o ativo e rejeita projeto", () => {
  const { home, m } = manager();
  const added = m.add(draft());
  m.use(added.id);
  expect(storeAt(home).activeProfileId).toBe(added.id);
  expect(() => m.use("p")).toThrow(/astro\.config\.json/);
});

test("list mescla projeto e global; ambiente que não é a fonte fica de fora", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-list-"));
  saveProfileStore({
    version: 1,
    activeProfileId: "openai-work",
    profiles: [
      {
        id: "openai-work",
        name: "OpenAI Work",
        kind: "openai-compat",
        baseUrl: "https://api.openai.com/v1",
        credentialRef: "OPENAI_API_KEY",
        models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
      },
      {
        id: "p",
        name: "p",
        kind: "openai-compat",
        baseUrl: "https://global-p.example/v1",
        credentialRef: "GLOBAL_KEY",
        models: [{ id: "m1", tags: [], context: 1000 }],
      },
    ],
  }, join(home, "providers.json"));
  const m = new ProfileManager({
    project: project(),
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  const list = m.list();
  const p = list.find((item) => item.id === "p");
  expect(p?.source).toBe("project");
  expect(p?.baseUrl).toBe("https://p.example/v1");
  expect(list.find((item) => item.id === "openai-work")?.source).toBe("global");
  expect(list.find((item) => item.id === "openai-work")?.active).toBe(true);
  // #472: projeto + store resolvem provider/modelo; o conjunto do ambiente é ignorado.
  expect(list.find((item) => item.id === "openai")).toBeUndefined();
});

test("list segue ASTRO_PROVIDER, não o activeProfileId", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-envprov-"));
  const base = {
    id: "openai-work", name: "OpenAI Work", kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1", credentialRef: "OPENAI_API_KEY",
    models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
  };
  saveProfileStore({
    version: 1,
    activeProfileId: "outro",
    profiles: [{ ...base, id: "outro", name: "Outro" }, base],
  }, join(home, "providers.json"));
  const m = new ProfileManager({
    project: project(),
    env: { ASTRO_HOME: home, ASTRO_PROVIDER: "openai-work" },
  });
  const list = m.list();
  expect(list.find((item) => item.id === "openai-work")?.active).toBe(true);
  expect(list.find((item) => item.id === "outro")?.active).toBe(false);
});

test("list marca o provider do projeto quando agent.profile decide", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-pool-"));
  const base = project();
  const pooled = validateConfig({
    providers: base.providers,
    models: base.models,
    agent: { profile: "fast", maxSteps: 2, tools: ["read_file"] },
    modelPool: { fast: { model: "p/m1" } },
    paths: base.paths,
  });
  saveProfileStore({
    version: 1,
    activeProfileId: "outro",
    profiles: [{
      id: "outro", name: "Outro", kind: "openai-compat",
      baseUrl: "https://o.example/v1", credentialRef: "GLOBAL_KEY",
      models: [{ id: "m1", tags: [], context: 1000 }],
    }],
  }, join(home, "providers.json"));
  const m = new ProfileManager({ project: pooled, env: { ASTRO_HOME: home } });
  expect(m.list().find((item) => item.id === "p")?.active).toBe(true);
  expect(m.list().find((item) => item.id === "outro")?.active).toBe(false);
  expect(() => m.use("outro")).toThrow(/agent\.profile/);
});

test("add rejeita id reservado env", () => {
  const { m } = manager();
  expect(() => m.add(draft({ name: "env" }))).toThrow(/reservado/);
});

test("add rejeita colisão com provider do projeto em qualquer caixa", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-case-"));
  const base = project();
  const upper = validateConfig({
    providers: { P: base.providers.p! },
    models: base.models.map((model) => ({ ...model, provider: "P" })),
    agent: { ...base.agent, model: "P/m1" },
    paths: base.paths,
  });
  const m = new ProfileManager({ project: upper, env: { ASTRO_HOME: home } });
  expect(() => m.add(draft({ name: "p" }))).toThrow(/astro\.config\.json/);
});

test("list não cria arquivo com perfil de env", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-nowrite-"));
  // Sem projeto e sem store, o ambiente é a fonte e entra na lista sem gravar nada.
  const m = new ProfileManager({
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  expect(m.list().find((item) => item.id === "openai")?.source).toBe("env");
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("remove de perfil não ativo preserva o ativo", () => {
  const { home, m } = manager();
  const a = m.add(draft({ name: "A" }));
  m.add(draft({ name: "B" }));
  m.use(a.id);
  m.remove("b");
  expect(storeAt(home).activeProfileId).toBe(a.id);
});

test("remove recusa perfil referenciado pelo projeto", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-ref-"));
  const base = project();
  const raw = {
    ...base,
    models: [...base.models, { provider: "q", id: "m2", tags: [], context: 1000 }],
    agent: { ...base.agent, model: "q/m2" },
  } as unknown as AstroConfig;
  saveProfileStore({
    version: 1,
    profiles: [{
      id: "q", name: "Q", kind: "openai-compat",
      baseUrl: "https://q.example/v1", credentialRef: "KEY",
      models: [{ id: "m2", tags: [], context: 1000 }],
    }],
  }, join(home, "providers.json"));
  const m = new ProfileManager({ project: raw, env: { ASTRO_HOME: home } });
  expect(() => m.remove("q")).toThrow(/usado por astro\.config\.json/);
});

test("env não é gravado por add/edit", () => {
  const home = mkdtempSync(join(tmpdir(), "astro-mgr-env-"));
  const m = new ProfileManager({
    env: { ASTRO_HOME: home, OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-4o" },
  });
  expect(m.list().find((item) => item.id === "openai")?.source).toBe("env");
  m.add(draft());
  expect(existsSync(join(home, "config.json"))).toBe(true); // #492: escrita na camada global
  expect(existsSync(join(home, "providers.json"))).toBe(false); // legado nunca é escrito
  expect(storeAt(home).profiles.some((item) => item.id === "openai")).toBe(false);
});
