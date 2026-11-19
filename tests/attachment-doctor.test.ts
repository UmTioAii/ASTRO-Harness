import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, doctorJson, exitCode, renderReport, runChecks } from "../src/doctor";
import { ArtifactStore } from "../src/attachments/store";
import { FAKE_PRIVATE_ACL } from "./setup";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): { base: string; projectCwd: string; astroHome: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "astro-att-doctor-"));
  const projectCwd = mkdtempSync(join(tmpdir(), "astro-att-project-"));
  dirs.push(base, projectCwd);
  const astroHome = join(base, "home");
  const root = join(base, "artifacts");
  mkdirSync(astroHome, { recursive: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return { base, projectCwd, astroHome, root };
}

function envFor(astroHome: string, root: string): NodeJS.ProcessEnv {
  return { ...process.env, ASTRO_HOME: astroHome, ASTRO_ARTIFACT_ROOT: root };
}

describe("doctor de anexos (#392)", () => {
  test("raiz ausente vira warn e não cria o diretório", () => {
    const { base, projectCwd, astroHome } = sandbox();
    const root = join(base, "missing");
    const env = envFor(astroHome, root);
    const report = runChecks(collectFacts(process.cwd(), { projectCwd, env, checkPrivate: () => true }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("ausente");
    expect(existsSync(root)).toBe(false);
  });

  test("raiz inválida vira fail com o motivo redigido", () => {
    const { projectCwd, astroHome } = sandbox();
    const secret = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
    const root = join(projectCwd, secret);
    const env = envFor(astroHome, root);
    const report = runChecks(collectFacts(process.cwd(), { projectCwd, env, checkPrivate: () => true }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("fail");
    expect(check?.detail).toContain("fora do cwd");
    expect(check?.detail).not.toContain(secret);
  });

  test("raiz que é arquivo vira fail, não ok", () => {
    const { base, projectCwd, astroHome } = sandbox();
    const root = join(base, "not-a-directory");
    writeFileSync(root, "x");
    const env = envFor(astroHome, root);
    const report = runChecks(collectFacts(process.cwd(), { projectCwd, env, checkPrivate: () => true }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("fail");
    expect(check?.detail).toContain("diretório");
  });

  test.skipIf(process.platform === "win32")("raiz sem busca/escrita vira fail", () => {
    const { projectCwd, astroHome, root } = sandbox();
    chmodSync(root, 0o600);
    const report = runChecks(collectFacts(process.cwd(), { projectCwd, env: envFor(astroHome, root), checkPrivate: () => true }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("fail");
    expect(check?.detail).toMatch(/gravável|permiss|EACCES/i);
  });

  test.skipIf(process.platform !== "win32")("ACL que nega subdiretório vira fail", () => {
    const { projectCwd, astroHome, root } = sandbox();
    const user = process.env.USERNAME ?? "";
    try {
      execFileSync("icacls", [root, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
      execFileSync("icacls", [root, "/deny", `${user}:(AD)`], { stdio: "ignore" });
    } catch (error) {
      throw new Error(`não foi possível preparar a ACL de teste: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const report = runChecks(collectFacts(process.cwd(), { projectCwd, env: envFor(astroHome, root), checkPrivate: () => true }));
      const check = report.checks.find((item) => item.label === "anexos");
      expect(check?.level).toBe("fail");
      expect(check?.detail).toContain("gravável");
    } finally {
      try { execFileSync("icacls", [root, "/remove:d", user], { stdio: "ignore" }); } catch { /* melhor esforço */ }
    }
  });

  test.skipIf(process.platform !== "win32")("ACL que nega listagem vira fail", () => {
    const { projectCwd, astroHome, root } = sandbox();
    const user = process.env.USERNAME ?? "";
    try {
      execFileSync("icacls", [root, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
      execFileSync("icacls", [root, "/deny", `${user}:(RD)`], { stdio: "ignore" });
    } catch (error) {
      throw new Error(`não foi possível preparar a ACL de teste: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const report = runChecks(collectFacts(process.cwd(), { projectCwd, env: envFor(astroHome, root), checkPrivate: () => true }));
      const check = report.checks.find((item) => item.label === "anexos");
      expect(check?.level).toBe("fail");
      expect(check?.detail).toMatch(/gravável|permiss|EACCES|EPERM/i);
    } finally {
      try { execFileSync("icacls", [root, "/remove:d", user], { stdio: "ignore" }); } catch { /* melhor esforço */ }
    }
  });

  test("probe de escrita que falha vira fail e não deixa temporário", () => {
    const { projectCwd, astroHome, root } = sandbox();
    const env = envFor(astroHome, root);
    const report = runChecks(collectFacts(process.cwd(), { projectCwd, env, checkPrivate: () => true, probeWritable: () => false }));
    const check = report.checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("fail");
    expect(check?.detail).toContain("gravável");
    expect(readdirSync(root).filter((name) => name.startsWith(".doctor-"))).toEqual([]);
  });

  test("artifactRoot relativo é rejeitado como não absoluto", () => {
    const { projectCwd, astroHome, root } = sandbox();
    const facts = collectFacts(process.cwd(), {
      projectCwd,
      env: envFor(astroHome, root), checkPrivate: () => true, artifactRoot: join("rel", "artifacts"),
    });
    expect(facts.attachments.root).toBe(join("rel", "artifacts"));
    expect(facts.attachments.invalidReason).toContain("absoluta");
    const check = runChecks(facts).checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("fail");
  });

  test("artifactRoot válido vence a env válida", () => {
    const { base, projectCwd, astroHome, root } = sandbox();
    const override = join(base, "override");
    mkdirSync(override, { recursive: true, mode: 0o700 });
    const facts = collectFacts(process.cwd(), {
      projectCwd,
      env: envFor(astroHome, root), checkPrivate: () => true, probeWritable: () => true, artifactRoot: override,
    });
    expect(facts.attachments.root).toBe(override);
    expect(facts.attachments.invalidReason).toBeUndefined();
    expect(runChecks(facts).checks.find((item) => item.label === "anexos")?.level).toBe("ok");
  });

  test("lê TTL e teto da config global efetiva", () => {
    const { projectCwd, astroHome, root } = sandbox();
    writeFileSync(join(astroHome, "config.json"), JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: "http://127.0.0.1:1/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", tools: [] },
      attachments: { artifactTtlDays: 30, artifactMaxBytes: 4096 },
    }));
    const facts = collectFacts(process.cwd(), { projectCwd, env: envFor(astroHome, root), checkPrivate: () => true });
    expect(facts.attachments).toMatchObject({ ttlDays: 30, maxBytes: 4096 });
  });

  test("config efetiva inválida vira fail sanitizado e não mostra defaults", () => {
    const { projectCwd, astroHome, root } = sandbox();
    writeFileSync(join(astroHome, "config.json"), JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: "https://api.example.com/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", tools: [] },
      attachments: { artifactTtlDays: 30, artifactMaxBytes: 4096 },
    }));
    writeFileSync(join(projectCwd, "project-config.json"), JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: "https://api.example.com/v1", credentialRef: "KEY" } },
      models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
      agent: { model: "p/m1", tools: ["read_file"] },
      paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
      attachments: { artifactTtlDays: 45, artifactMaxBytes: 8192 },
    }));

    const facts = collectFacts(process.cwd(), {
      projectCwd,
      configPath: join(projectCwd, "project-config.json"),
      env: envFor(astroHome, root),
      checkPrivate: () => true,
    });
    expect(facts.config.effectiveError).toContain("amplia a allowlist global");

    const report = runChecks(facts);
    const config = report.checks.find((item) => item.name === "config");
    const attachments = report.checks.find((item) => item.name === "attachments");
    expect(config?.level).toBe("fail");
    expect(config?.detail).toContain("config efetiva inválida");
    expect(attachments?.level).toBe("fail");
    expect(attachments?.detail).not.toContain("TTL");
    expect(attachments?.detail).not.toContain("1.0 GiB");
    expect(exitCode(report)).toBe(1);
  });

  test("config global inválida sem provider vira fail sanitizado e não mostra defaults", () => {
    const { projectCwd, astroHome, root } = sandbox();
    writeFileSync(join(astroHome, "config.json"), JSON.stringify({
      attachments: { artifactTtlDays: "not-a-number" },
    }));

    const facts = collectFacts(process.cwd(), {
      projectCwd,
      env: envFor(astroHome, root),
      checkPrivate: () => true,
    });
    const report = runChecks(facts);
    const config = report.checks.find((item) => item.name === "config");
    const attachments = report.checks.find((item) => item.name === "attachments");
    expect(config?.level).toBe("fail");
    expect(attachments?.level).toBe("fail");
    expect(attachments?.detail ?? "").toContain("config efetiva inválida");
    expect(attachments?.detail ?? "").not.toContain("TTL");
    expect(attachments?.detail ?? "").not.toContain("1.0 GiB");
    expect(facts.attachments.ttlDays).toBeUndefined();
    expect(exitCode(report)).toBe(1);
  });

  test("erro de config não expõe valor sintético no caminho", () => {
    const { projectCwd, astroHome, root } = sandbox();
    const secret = ["s", "k", "-", "doctor", "-", "SYNTHETIC", "123456789"].join("");
    const secretDir = join(projectCwd, `cfg-${secret}`);
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "astro.config.json"), "{not json", "utf8");

    const facts = collectFacts(process.cwd(), {
      projectCwd,
      configPath: join(secretDir, "astro.config.json"),
      env: envFor(astroHome, root),
      checkPrivate: () => true,
    });
    expect(facts.config.error).toBeString();
    expect(facts.config.error ?? "").not.toContain(secret);

    const report = runChecks(facts);
    const rendered: string[] = [];
    renderReport(report, (line) => rendered.push(line));
    expect(rendered.join("\n")).not.toContain(secret);
    expect(JSON.stringify(doctorJson(report))).not.toContain(secret);
  });

  test("raiz válida reporta uso, artefatos e último GC", () => {
    const { projectCwd, astroHome, root } = sandbox();
    const env = envFor(astroHome, root);
    const store = new ArtifactStore(root, {
      cwd: projectCwd, astroHome, checkPrivate: () => true, hardenPrivate: () => FAKE_PRIVATE_ACL,
    });
    store.save({ sessionId: "s1", runId: "r1" }, new Uint8Array([1, 2, 3]), "image/png");
    store.gc();
    const facts = collectFacts(process.cwd(), { projectCwd, env, checkPrivate: () => true });
    expect(facts.attachments).toMatchObject({ exists: true, usageBytes: 3, artifacts: 1 });
    expect(facts.attachments.lastGc).toBeString();
    expect(readdirSync(root).filter((name) => name.startsWith(".doctor-"))).toEqual([]);
    const check = runChecks(facts).checks.find((item) => item.label === "anexos");
    expect(check?.level).toBe("ok");
    expect(check?.detail).toContain("1 artefato");
    expect(check?.detail).toContain("3 B");
    expect(check?.detail).toContain("TTL 7d");
    expect(check?.detail).toContain(facts.attachments.lastGc!);
  });
});
