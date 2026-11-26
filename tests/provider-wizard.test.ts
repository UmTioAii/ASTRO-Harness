import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/core/config";
import { runProviderWizard, saveProviderProfile } from "../src/chat/provider-wizard";
import { ProfileManager } from "../src/providers/profile-manager";
import { profileStoreFromConfig } from "../src/providers/profiles";

function project() {
  return validateConfig({
    providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "astro-wizard-"));
  const manager = new ProfileManager({ project: project(), env: { ASTRO_HOME: home, ...env } });
  return { home, manager };
}

function fakeIO(answers: string[]) {
  const out: string[] = [];
  let index = 0;
  return {
    out,
    io: {
      read: async () => answers[index++] ?? null,
      write: (text: string) => { out.push(text); },
    },
  };
}

test("add pelo catálogo grava, ativa e chama onUse", async () => {
  const { home, manager } = setup();
  const used: string[] = [];
  const { io, out } = fakeIO(["nvidia", "NVIDIA Work", "", "", "", "S", "S"]);
  const view = await runProviderWizard(io, manager, { mode: "add", onUse: (id) => used.push(id) });
  expect(view?.id).toBe("nvidia-work");
  expect(used).toEqual(["nvidia-work"]);
  const store = profileStoreFromConfig(join(home, "config.json")); // #492: camada global
  expect(store.activeProfileId).toBe("nvidia-work");
  expect(store.profiles[0]!.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  expect(existsSync(join(home, "providers.json"))).toBe(false); // legado nunca é escrito
  expect(out.join(" ")).toContain("salvo: nvidia-work");
});

test("add pelo catálogo persiste o quotaDomain da entrada", async () => {
  const { manager } = setup();
  const { io } = fakeIO(["nvidia", "NVIDIA Work", "", "", "", "S", "n"]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(manager.list().find((item) => item.id === "nvidia-work")?.quotaDomain).toBe("nvidia");
});

test("add custom sem chave e sem ativar", async () => {
  const { home, manager } = setup();
  const { io } = fakeIO(["custom", "Ollama", "http://localhost:11434/v1", "llama3.1", "", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view?.credentialRef).toBeUndefined();
  expect(view?.baseUrl).toBe("http://localhost:11434/v1");
  expect(profileStoreFromConfig(join(home, "config.json")).activeProfileId).toBeUndefined();
});

test("avisa quando a variável da chave não existe", async () => {
  const { manager } = setup();
  const { io, out } = fakeIO(["custom", "Local", "http://localhost:1/v1", "m1", "MISSING_KEY", "S", "n"]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(out.join(" ")).toContain("MISSING_KEY não encontrada");
});

test("cancelar no confirmar não grava", async () => {
  const { home, manager } = setup();
  const { io } = fakeIO(["custom", "X", "http://x/v1", "m1", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view).toBeUndefined();
  expect(existsSync(join(home, "providers.json"))).toBe(false);
});

test("edit mantém o id e atualiza a baseUrl", async () => {
  const { manager } = setup();
  const added = manager.add({
    name: "OpenAI Work",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    credentialRef: "OPENAI_API_KEY",
    models: [{ id: "gpt-4o", tags: ["writing-code"], context: 128000 }],
  });
  const { io } = fakeIO(["OpenAI Work 2", "https://proxy.example/v1", "", "", "S"]);
  const view = await runProviderWizard(io, manager, { mode: "edit", profile: added });
  expect(view?.id).toBe(added.id);
  expect(view?.name).toBe("OpenAI Work 2");
  expect(view?.baseUrl).toBe("https://proxy.example/v1");
});

test("modelos vazios não salvam", async () => {
  const { manager } = setup();
  const { io, out } = fakeIO(["custom", "X", "http://x/v1", "", " ; "]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(out.join(" ")).toContain("ao menos um modelo");
});

test("credentialRef inválido é re-perguntado até virar nome de variável válido (#286)", async () => {
  const { manager } = setup({ MINHA_CHAVE: "x" });
  const { io, out } = fakeIO(["custom", "Local", "http://localhost:1/v1", "m1", "minha chave", "MINHA_CHAVE", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view?.credentialRef).toBe("MINHA_CHAVE");
  expect(out.join(" ")).toContain("variável");
});

test("chave colada no prompt de variável não vaza na mensagem (I-03)", async () => {
  const { manager } = setup();
  const secret = "sk-sentinel-do-not-store";
  const { io, out } = fakeIO(["custom", "Local", "http://localhost:1/v1", "m1", secret]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view).toBeUndefined();
  expect(out.join("\n")).not.toContain(secret);
  expect(out.join("\n")).toContain("cofre");
});

test("an invalid catalog answer never echoes a pasted key (#629)", async () => {
  const { manager } = setup();
  const secret = "sk-selector-sentinel";
  const { io, out } = fakeIO([secret]);
  await runProviderWizard(io, manager, { mode: "add" });
  expect(out.join("\n")).toContain("unknown option");
  expect(out.join("\n")).not.toContain(secret);
});

test("a vault write error never prints the pasted key (#629)", async () => {
  const { manager } = setup();
  const secret = "sk-vault-error-sentinel";
  const { io, out } = fakeIO(["custom", "Local", "http://localhost:1/v1", "m1", secret, "S"]);
  const view = await runProviderWizard(io, manager, {
    mode: "add",
    saveSecret: () => { throw new Error(`vault write failed: ${secret}`); },
    discardSecret: () => {},
  });
  expect(view).toBeUndefined();
  expect(out.join("\n")).toContain("erro:");
  expect(out.join("\n")).not.toContain(secret);
});

test("a pasted key requires rollback before any profile or vault write (#629)", () => {
  const { manager } = setup();
  let vaultWrites = 0;
  const result = saveProviderProfile({
    manager,
    mode: "add",
    draft: {
      name: "Local", kind: "openai-compat", baseUrl: "http://localhost:1/v1",
      models: [{ id: "m1", tags: [], context: 8192 }],
    },
    secret: "sk-rollback-sentinel",
    saveSecret: () => { vaultWrites++; return "vault:cred-rollback"; },
  });
  expect(result.saved).toBeUndefined();
  expect(result.error).toContain("cofre");
  expect(vaultWrites).toBe(0);
  expect(manager.list().some((profile) => profile.name === "Local")).toBe(false);
});

test("credentialRef vazio continua sem chave (#286)", async () => {
  const { manager } = setup();
  const { io } = fakeIO(["custom", "Local", "http://localhost:1/v1", "m1", "", "S", "n"]);
  const view = await runProviderWizard(io, manager, { mode: "add" });
  expect(view?.credentialRef).toBeUndefined();
});
