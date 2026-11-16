import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, runChecks } from "../scripts/doctor";
import { ArtifactStore } from "../src/attachments/store";
import { FAKE_PRIVATE_ACL } from "./setup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { base: string; astroHome: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "astro-att-doctor-"));
  dirs.push(base);
  const astroHome = join(base, "home");
  const root = join(base, "artifacts");
  mkdirSync(astroHome, { recursive: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return { base, astroHome, root };
}

function envFor(astroHome: string, root: string): NodeJS.ProcessEnv {
  return { ...process.env, ASTRO_HOME: astroHome, ASTRO_ARTIFACT_ROOT: root };
}

describe("doctor de anexos (#392)", () => {
  test("raiz ausente vira warn e não cria o diretório", () => {
    const { base, astroHome } = sandbox();
    const root = join(base, "missing");
    const env = envFor(astroHome, root);
    const report = runChecks(collectFacts(process.cwd(), { env, checkPrivate: () => true }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("ausente");
    expect(existsSync(root)).toBe(false);
  });

  test("raiz inválida vira fail com o motivo redigido", () => {
    const { astroHome } = sandbox();
    const root = join(process.cwd(), "attachments");
    const env = envFor(astroHome, root);
    const report = runChecks(collectFacts(process.cwd(), { env, checkPrivate: () => true }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("fail");
    expect(check?.detail).toContain("fora do cwd");
  });

  test("raiz válida reporta uso, artefatos e último GC", () => {
    const { astroHome, root } = sandbox();
    const env = envFor(astroHome, root);
    const store = new ArtifactStore(root, {
      cwd: process.cwd(), astroHome, checkPrivate: () => true, hardenPrivate: () => FAKE_PRIVATE_ACL,
    });
    store.save({ sessionId: "s1", runId: "r1" }, new Uint8Array([1, 2, 3]), "image/png");
    store.gc();
    const facts = collectFacts(process.cwd(), { env, checkPrivate: () => true });
    expect(facts.attachments).toMatchObject({ exists: true, usageBytes: 3, artifacts: 1 });
    expect(facts.attachments.lastGc).toBeString();
    const check = runChecks(facts).checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("ok");
    expect(check?.detail).toContain("1 artefato");
    expect(check?.detail).toContain("3 B");
    expect(check?.detail).toContain("TTL 7d");
    expect(check?.detail).toContain(facts.attachments.lastGc!);
  });
});
