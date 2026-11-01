import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalFolder,
  ensureTrustedCwd,
  loadTrustedStore,
  saveTrustedStore,
  TrustedFolders,
  TrustDeniedError,
  trustedPath,
  trustChoice,
  trustPrompt,
  validateTrustedStore,
} from "../src/trust";

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "astro-trust-"));
  return { dir, path: join(dir, "trusted.json") };
}

// Fixture de segredo construído em runtime para não disparar o gate de segredos.
const FAKE_SECRET = ["s", "k", "-"].join("") + "live-abcdef12345";

describe("trustedPath (#267)", () => {
  test("usa $ASTRO_HOME quando definido, senão ~/.astro/trusted.json", () => {
    expect(trustedPath({ ASTRO_HOME: join("C:", "x", "home") } as NodeJS.ProcessEnv))
      .toBe(join("C:", "x", "home", "trusted.json"));
    const noHome = { ...process.env } as NodeJS.ProcessEnv;
    delete noHome.ASTRO_HOME;
    expect(trustedPath(noHome)).toBe(join(homedir(), ".astro", "trusted.json"));
  });
});

describe("store de trust (#267)", () => {
  test("arquivo ausente → store vazio", () => {
    const { path } = tmpStore();
    expect(loadTrustedStore(path)).toEqual({ version: 1, folders: [] });
  });

  test("roundtrip: grava atômico (0600 no POSIX) e relê igual", () => {
    const { path } = tmpStore();
    saveTrustedStore({ version: 1, folders: ["/a", "/b"] }, path);
    expect(loadTrustedStore(path)).toEqual({ version: 1, folders: ["/a", "/b"] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("JSON corrompido → erro cita o caminho e NÃO ecoa o conteúdo (I-03)", () => {
    const { path } = tmpStore();
    writeFileSync(path, `{"version":1,"folders":["${FAKE_SECRET}"]`); // JSON inválido com segredo
    let err: Error | undefined;
    try {
      loadTrustedStore(path);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain(path);
    expect(err!.message).not.toContain(FAKE_SECRET);
  });

  test("campo desconhecido → erro; versão/folders inválidos → erro", () => {
    const { path } = tmpStore();
    writeFileSync(path, JSON.stringify({ version: 1, folders: [], surprise: FAKE_SECRET }));
    expect(() => loadTrustedStore(path)).toThrow(/campo desconhecido/);
    expect(() => loadTrustedStore(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    try {
      loadTrustedStore(path);
    } catch (e) {
      expect((e as Error).message).not.toContain(FAKE_SECRET); // só o nome do campo, nunca o valor
    }
    expect(() => validateTrustedStore({ version: 2, folders: [] })).toThrow(/version/);
    expect(() => validateTrustedStore({ version: 1, folders: "x" })).toThrow(/folders/);
    expect(() => validateTrustedStore({ version: 1, folders: [42] })).toThrow(/folders/);
    expect(() => validateTrustedStore("não-objeto")).toThrow();
  });
});

describe("TrustedFolders (#267)", () => {
  test("trust persiste e nova instância relê; canonicaliza o caminho", () => {
    const { dir, path } = tmpStore();
    const folders = new TrustedFolders(path);
    folders.trust(dir);
    expect(existsSync(path)).toBe(true);
    expect(folders.isTrusted(dir)).toBe(true);
    expect(new TrustedFolders(path).isTrusted(dir)).toBe(true);
    expect(new TrustedFolders(path).list()).toEqual([canonicalFolder(dir)]);
    // caminho equivalente (com subpasta inexistente) também é coberto
    expect(folders.isTrusted(join(dir, "sub"))).toBe(true);
    expect(folders.isTrusted(join(dir, "..", "outra"))).toBe(false);
  });

  test("revoke remove e persiste; revogar o que não existe é no-op sem gravar", () => {
    const { dir, path } = tmpStore();
    const folders = new TrustedFolders(path);
    expect(folders.revoke(dir)).toBe(false);
    expect(existsSync(path)).toBe(false);
    folders.trust(dir);
    expect(folders.revoke(dir)).toBe(true);
    expect(folders.isTrusted(dir)).toBe(false);
    expect(new TrustedFolders(path).isTrusted(dir)).toBe(false);
  });

  test("canonicalFolder usa realpath quando existe, resolve quando não", () => {
    const { dir } = tmpStore();
    expect(canonicalFolder(dir)).toBe(realpathSync(resolve(dir)));
    const ghost = join(dir, "nao-existe");
    expect(canonicalFolder(ghost)).toBe(resolve(ghost));
  });
});

describe("ensureTrustedCwd (#267, I-11)", () => {
  test("primeiro open pergunta; aprovar persiste + audita allow", async () => {
    const { dir, path } = tmpStore();
    const asked: string[] = [];
    const events: Array<{ folder: string; decision: string }> = [];
    await ensureTrustedCwd(dir, {
      path,
      ask: async (cwd) => {
        asked.push(cwd);
        return true;
      },
      onDecision: (folder, decision) => events.push({ folder, decision }),
    });
    expect(asked).toEqual([canonicalFolder(dir)]);
    expect(events).toEqual([{ folder: canonicalFolder(dir), decision: "allow" }]);
    expect(new TrustedFolders(path).isTrusted(dir)).toBe(true);
  });

  test("pasta já confiável não pergunta de novo", async () => {
    const { dir, path } = tmpStore();
    const folders = new TrustedFolders(path);
    folders.trust(dir);
    let asked = 0;
    await ensureTrustedCwd(dir, {
      path,
      ask: async () => {
        asked++;
        return false;
      },
    });
    expect(asked).toBe(0);
  });

  test("negar joga TrustDeniedError (trust_denied), audita deny e não persiste", async () => {
    const { dir, path } = tmpStore();
    const events: Array<{ folder: string; decision: string }> = [];
    const err = await ensureTrustedCwd(dir, {
      path,
      ask: async () => false,
      onDecision: (folder, decision) => events.push({ folder, decision }),
    }).catch((e) => e as Error);
    expect(err).toBeInstanceOf(TrustDeniedError);
    expect((err as TrustDeniedError).code).toBe("trust_denied");
    expect(events).toEqual([{ folder: canonicalFolder(dir), decision: "deny" }]);
    expect(existsSync(path)).toBe(false);
    expect(new TrustedFolders(path).isTrusted(dir)).toBe(false);
  });

  test("sem ask (não-TTY/eval) prossegue em silêncio e não persiste", async () => {
    const { dir, path } = tmpStore();
    await ensureTrustedCwd(dir, { path });
    expect(existsSync(path)).toBe(false);
  });
});

describe("prompt de trust (#267)", () => {
  test("trustPrompt cita a pasta; trustChoice aceita s/sim/y/yes e nega o resto", () => {
    expect(trustPrompt("/tmp/x")).toContain("/tmp/x");
    for (const yes of ["s", "S", "sim", "yes", " y "]) expect(trustChoice(yes)).toBe(true);
    for (const no of ["n", "", "talvez", null, undefined as unknown as null]) expect(trustChoice(no)).toBe(false);
  });

  test("canonicalFolder não deixa .. escapar na checagem de ancestralidade", () => {
    const { dir, path } = tmpStore();
    const folders = new TrustedFolders(path);
    folders.trust(dir);
    const outside = resolve(dir, "..", "..", "etc");
    const rel = relative(canonicalFolder(dir), canonicalFolder(outside));
    expect(isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..").toBe(true);
    expect(folders.isTrusted(outside)).toBe(false);
  });
});
