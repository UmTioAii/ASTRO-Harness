import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeActiveCredential, recoverActiveCredential, writeRecoveredCredentialRef, type MissingActiveCredential,
} from "../src/tui/credential-boot";
import { Vault, type VaultBackend } from "../src/vault";

// Sentinel built at runtime so the secret gate does not match the fixture.
const plain: VaultBackend = { scheme: "plain", protect: (s) => s, unprotect: (s) => s };
const SECRET = ["s", "k", "-"].join("") + "live-abcdef12345";

function workdir() {
  const root = mkdtempSync(join(tmpdir(), "astro-tui-credential-"));
  const home = join(root, "home");
  return { root, home, configPath: join(root, "astro.config.json"), env: { ASTRO_HOME: home } as NodeJS.ProcessEnv };
}

function layer(provider: string, credentialRef?: string): string {
  return JSON.stringify({
    providers: { [provider]: { kind: "openai-compat", baseUrl: `https://${provider}.example/v1`, ...(credentialRef === undefined ? {} : { credentialRef }) } },
    models: [{ provider, id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: `${provider}/m1`, maxSteps: 2, tools: [] },
    permissions: { mode: "allow-edits" },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }, null, 2);
}

type Dir = ReturnType<typeof workdir>;
const vaultOf = (w: Dir) => new Vault(join(w.home, "vault.json"), plain);
const probe = (w: Dir, vault: Vault, env: NodeJS.ProcessEnv = w.env) =>
  probeActiveCredential({ configPath: w.configPath, env, vault, allowMissing: true });

/** Runs one recovery and returns the outcome plus everything printed (I-03 assertions). */
async function recover(
  w: Dir, vault: Vault, recoverFn: (missing: MissingActiveCredential) => Promise<boolean>, env: NodeJS.ProcessEnv = w.env,
) {
  const notes: string[] = [];
  const outcome = await recoverActiveCredential({
    probe: () => probe(w, vault, env), recover: recoverFn, notify: (message) => notes.push(message),
  });
  return { outcome, notes };
}

describe("boot da TUI: credencial ativa ausente (#616)", () => {
  test("detecta a variável de ambiente ausente nomeando só o ref", () => {
    const w = workdir();
    writeFileSync(w.configPath, layer("p", "P_KEY"));
    const missing = probe(w, vaultOf(w));
    expect(missing).toMatchObject({ provider: "p", model: "p/m1", credentialRef: "P_KEY", source: "project" });
    expect(missing?.message).toContain("P_KEY");
    expect(missing?.message).not.toContain(SECRET);
  });

  test("credencial presente não abre a recuperação", async () => {
    const w = workdir();
    writeFileSync(w.configPath, layer("p", "P_KEY"));
    const env = { ...w.env, P_KEY: SECRET };
    let prompts = 0;
    const { outcome } = await recover(w, vaultOf(w), async () => { prompts++; return true; }, env);
    expect(probe(w, vaultOf(w), env)).toBeUndefined();
    expect(outcome).toEqual({ kind: "not-needed" });
    expect(prompts).toBe(0);
  });

  test("id de vault ausente é detectado pelo ref, nunca pelo valor", () => {
    const w = workdir();
    const ref = "vault:cred-missing-0000";
    writeFileSync(w.configPath, layer("p", ref));
    const missing = probe(w, vaultOf(w));
    expect(missing?.credentialRef).toBe(ref);
    expect(missing?.message).toContain(ref);
    expect(missing?.message).not.toContain(SECRET);
  });

  test("recusa não escreve nada e devolve a mensagem acionável", async () => {
    const w = workdir();
    writeFileSync(w.configPath, layer("p", "P_KEY"));
    const before = readFileSync(w.configPath, "utf8");
    const { outcome, notes } = await recover(w, vaultOf(w), async () => false);
    expect(outcome.kind).toBe("declined");
    expect(readFileSync(w.configPath, "utf8")).toBe(before);
    expect(notes.join("\n")).toContain("P_KEY");
    expect(notes.join("\n")).not.toContain(SECRET);
  });

  test("chave colada entra no cofre e o projeto guarda só credentialRef", async () => {
    const w = workdir();
    writeFileSync(w.configPath, layer("p", "P_KEY"));
    const before = JSON.parse(readFileSync(w.configPath, "utf8"));
    const vault = vaultOf(w);
    const { outcome, notes } = await recover(w, vault, async (missing) => {
      const created = vault.create({ providerId: missing.provider, label: "tui", secret: SECRET });
      writeRecoveredCredentialRef({ missing, ref: `vault:${created.id}`, configPath: w.configPath, env: w.env });
      return true;
    });
    expect(outcome.kind).toBe("recovered");
    const after = JSON.parse(readFileSync(w.configPath, "utf8"));
    expect(after).toMatchObject({
      models: before.models, agent: before.agent,
      providers: { p: { baseUrl: before.providers.p.baseUrl } },
    });
    expect(after.providers.p.credentialRef).toMatch(/^vault:cred-/);
    expect(readFileSync(w.configPath, "utf8") + notes.join("\n")).not.toContain(SECRET);
    expect(probe(w, vault)).toBeUndefined();
  });

  test("projeto aceita nome de variável na recuperação e grava só o ref", async () => {
    const w = workdir();
    writeFileSync(w.configPath, layer("p", "OLD_KEY"));
    const env = { ...w.env, NEW_KEY: SECRET };
    const { outcome } = await recover(w, vaultOf(w), async (missing) => {
      writeRecoveredCredentialRef({ missing, ref: "NEW_KEY", configPath: w.configPath, env });
      return true;
    }, env);
    expect(outcome.kind).toBe("recovered");
    expect(JSON.parse(readFileSync(w.configPath, "utf8")).providers.p.credentialRef).toBe("NEW_KEY");
    expect(readFileSync(w.configPath, "utf8")).not.toContain(SECRET);
  });

  test("camada global aceita nome de variável e grava só credentialRef", async () => {
    const w = workdir();
    mkdirSync(w.home, { recursive: true });
    const globalPath = join(w.home, "config.json");
    writeFileSync(globalPath, layer("g", "OLD_KEY"));
    const before = JSON.parse(readFileSync(globalPath, "utf8"));
    const vault = vaultOf(w);
    const env = { ...w.env };
    expect(probe(w, vault, env)?.source).toBe("global");
    const { outcome } = await recover(w, vault, async (missing) => {
      env.NEW_KEY = SECRET; // exported after the prompt; never written to a layer
      writeRecoveredCredentialRef({ missing, ref: "NEW_KEY", configPath: w.configPath, env });
      return true;
    }, env);
    expect(outcome.kind).toBe("recovered");
    const after = JSON.parse(readFileSync(globalPath, "utf8"));
    expect(after).toMatchObject({
      providers: { g: { baseUrl: before.providers.g.baseUrl, credentialRef: "NEW_KEY" } }, models: before.models,
    });
    expect(readFileSync(globalPath, "utf8")).not.toContain(SECRET);
    expect(probe(w, vault, env)).toBeUndefined();
  });
});
