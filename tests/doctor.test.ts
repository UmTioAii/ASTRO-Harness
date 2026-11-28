import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  applyFixes,
  collectFacts,
  collectOnlineChecks,
  doctorJson,
  exitCode,
  modelFactFor,
  renderReport,
  runChecks,
  runDoctor,
  satisfiesMinimum,
  type DoctorFacts,
} from "../src/doctor";
import { projectSkillsRoot } from "../src/home-layout";
import { composeEntry } from "../src/providers/catalog";

const VALID_SKILL = `---\nname: ok\ndescription: ok\nversion: 1.0.0\n---\nPrompt\n`;

function writeSkill(root: string, name: string, content: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), content, "utf8");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "astro-doctor-unit-"));
  dirs.push(dir);
  return dir;
}

const SENTINEL = "sentinel-xyz-do-not-print";

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    bunVersion: "1.4.2",
    nodeVersion: "22.1.0",
    engines: { bun: ">=1.4.0", node: ">=18" },
    missingModules: [],
    artifacts: [{ path: "dist/cli.js", exists: true }, { path: "dist/launcher.js", exists: true }],
    config: { path: "astro.config.json", present: false },
    astroHome: { path: "~/.astro", exists: true, writable: true },
    attachments: { root: "~/.astro/attachments", exists: true, ttlDays: 7, maxBytes: 1024 ** 3, usageBytes: 0, artifacts: 0 },
    env: {},
    ...over,
  };
}

function lines(report: ReturnType<typeof runChecks>): string {
  const out: string[] = [];
  renderReport(report, (line) => out.push(line));
  return out.join("\n");
}

test("ambiente completo passa com exit 0", () => {
  const report = runChecks(facts());
  expect(exitCode(report)).toBe(0);
  expect(report.checks.some((check) => check.level === "fail")).toBe(false);
  expect(lines(report)).toContain("bun 1.4.2");
});

test("bun abaixo do mínimo falha", () => {
  const report = runChecks(facts({ bunVersion: "1.3.9" }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "bun")).toBe(true);
});

test("node ausente falha", () => {
  const report = runChecks(facts({ nodeVersion: undefined }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "node")).toBe(true);
});

test("módulo de runtime ausente falha apontando bun install", () => {
  const report = runChecks(facts({ missingModules: ["ink"] }));
  const check = report.checks.find((item) => item.label === "dependências");
  expect(check?.level).toBe("fail");
  expect(check?.detail).toContain("bun install");
});

test("dist ausente é warn, não fail", () => {
  const report = runChecks(facts({
    artifacts: [
      { path: "dist/cli.js", exists: false },
      { path: "dist/launcher.js", exists: false },
    ],
  }));
  const check = report.checks.find((item) => item.label === "dist");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("bun run build");
  expect(exitCode(report)).toBe(0);
});

test("config ausente é ok (TUI abre o setup de provider)", () => {
  const report = runChecks(facts());
  const check = report.checks.find((item) => item.label === "config");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("setup");
});

test("config inválida é fail", () => {
  const report = runChecks(facts({
    config: { path: "astro.config.json", present: true, error: "configuração não é JSON válido" },
  }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "config")).toBe(true);
});

test("credencial aparece só pelo nome; o valor nunca é impresso", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "nvidia", credentialRef: "NVIDIA_API_KEY" }],
    },
    env: { NVIDIA_API_KEY: SENTINEL },
  }));
  const out = lines(report);
  expect(out).toContain("NVIDIA_API_KEY");
  expect(out).toContain("presente");
  expect(out).not.toContain(SENTINEL);
});

test("credencial ausente no ambiente é warn", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "nvidia", credentialRef: "NVIDIA_API_KEY" }],
    },
  }));
  const check = report.checks.find((item) => item.label.startsWith("credencial"));
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("NVIDIA_API_KEY");
  // #510: detail traz o próximo passo, não só "ausente no ambiente"
  expect(check?.detail).toContain("astro providers vault-import");
  expect(exitCode(report)).toBe(0);
});

test("anexos inválidos falham, ausentes avisam e válidos reportam uso", () => {
  const base = facts().attachments;
  const invalid = runChecks(facts({ attachments: { ...base, invalidReason: "raiz dentro do cwd" } }));
  expect(invalid.checks.find((item) => item.label === "anexos")?.level).toBe("fail");
  expect(exitCode(invalid)).toBe(1);

  const missing = runChecks(facts({ attachments: { ...base, exists: false } }));
  const missingCheck = missing.checks.find((item) => item.label === "anexos");
  expect(missingCheck?.level).toBe("warn");
  expect(missingCheck?.detail).toContain("ausente");

  const valid = runChecks(facts({ attachments: {
    ...base, realpath: "/real/attachments", usageBytes: 3, artifacts: 1, lastGc: "2026-11-16T12:00:00.000Z",
  } }));
  const validCheck = valid.checks.find((item) => item.label === "anexos");
  expect(validCheck?.level).toBe("ok");
  expect(validCheck?.detail).toContain("1 artefato");
  expect(validCheck?.detail).toContain("3 B");
  expect(validCheck?.detail).toContain("TTL 7d");
  expect(validCheck?.detail).toContain("2026-11-16T12:00:00.000Z");
});

test("ASTRO_HOME existente e não gravável falha", () => {
  const report = runChecks(facts({
    astroHome: { path: "~/.astro", exists: true, writable: false },
  }));
  expect(exitCode(report)).toBe(1);
  expect(report.checks.some((check) => check.level === "fail" && check.label === "astro home")).toBe(true);
});

test("satisfiesMinimum compara versões com e sem range", () => {
  expect(satisfiesMinimum("1.4.2", ">=1.4.0")).toBe(true);
  expect(satisfiesMinimum("1.3.9", ">=1.4.0")).toBe(false);
  expect(satisfiesMinimum("22.1.0", "18")).toBe(true);
  expect(satisfiesMinimum("16.20.0", ">=18")).toBe(false);
});

test("codex-oauth sem arquivo de credenciais é warn", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "codex", kind: "codex-oauth", credentialsReadable: false }],
    },
  }));
  const check = report.checks.find((item) => item.label === "credencial codex");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("credenciais");
  expect(exitCode(report)).toBe(0);
});

test("MCP com header env ausente é warn e cita só o nome", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      mcp: { servers: 2, enabled: 1, missingHeaderEnv: ["MCP_TOKEN"] },
    },
  }));
  const check = report.checks.find((item) => item.label === "mcp");
  expect(check?.level).toBe("warn");
  expect(check?.detail).toContain("MCP_TOKEN");
  expect(exitCode(report)).toBe(0);
});

test("MCP sem servidor configurado é ok", () => {
  const report = runChecks(facts({
    config: { path: "astro.config.json", present: true, mcp: { servers: 0, enabled: 0, missingHeaderEnv: [] } },
  }));
  const check = report.checks.find((item) => item.label === "mcp");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("nenhum servidor");
});

test("skills válidas contam por fonte e inválidas viram warn", () => {
  const valid = runChecks(facts({ skills: { project: 1, user: 2, warnings: [] } }));
  const validCheck = valid.checks.find((item) => item.label === "skills");
  expect(validCheck?.level).toBe("ok");
  expect(validCheck?.detail).toContain("1 no projeto");
  expect(validCheck?.detail).toContain("2 do usuário");

  const invalid = runChecks(facts({
    skills: { project: 0, user: 0, warnings: ['skill "broken" ignorada: frontmatter inválido'] },
  }));
  const invalidCheck = invalid.checks.find((item) => item.label === "skills");
  expect(invalidCheck?.level).toBe("warn");
  expect(invalidCheck?.detail).toContain("broken");
  expect(exitCode(invalid)).toBe(0);
});

test("disco sem escrita no cwd falha e reporta espaço livre", () => {
  const failing = runChecks(facts({ disk: { cwd: "/proj", writable: false, freeBytes: 1024 ** 3 } }));
  const failCheck = failing.checks.find((item) => item.label === "disco");
  expect(failCheck?.level).toBe("fail");
  expect(exitCode(failing)).toBe(1);

  const valid = runChecks(facts({ disk: { cwd: "/proj", writable: true, freeBytes: 2 * 1024 ** 3 } }));
  const okCheck = valid.checks.find((item) => item.label === "disco");
  expect(okCheck?.level).toBe("ok");
  expect(okCheck?.detail).toContain("2.0 GiB");
  expect(okCheck?.detail).toContain("atributo");
  expect(okCheck?.detail).not.toContain("gravável");
});

test("checks redigem padrão de segredo no detalhe", () => {
  const secret = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
  const report = runChecks(facts({ astroHome: { path: join("/tmp", secret), exists: false, writable: false } }));
  const text = lines(report);
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain(secret);
});

test("doctorJson tem schema, resumo e fixes opcional", () => {
  const report = runChecks(facts());
  const json = doctorJson(report);
  expect(json.schema).toBe("doctor/v1");
  expect(json.summary).toEqual({ ok: report.checks.length, warn: 0, fail: 0 });
  expect(json).not.toHaveProperty("fixes");

  const withFix = doctorJson(report, { applied: ["criado /tmp/home"], errors: [] });
  expect(withFix.fixes).toEqual({ applied: ["criado /tmp/home"], errors: [] });
});

test("applyFixes cria ASTRO_HOME, é idempotente e não cria a raiz de artefatos", () => {
  const base = sandbox();
  const home = join(base, "nested", "home");
  const env = { ...process.env, ASTRO_HOME: home };

  const first = applyFixes(env);
  expect(first.applied).toHaveLength(1);
  expect(first.errors).toEqual([]);
  expect(existsSync(home)).toBe(true);
  expect(existsSync(join(home, "attachments"))).toBe(false);

  const second = applyFixes(env);
  expect(second.applied).toEqual([]);
  expect(second.errors).toEqual([]);
});

test("applyFixes não sobrescreve ASTRO_HOME que é arquivo", () => {
  const base = sandbox();
  const home = join(base, "file-home");
  writeFileSync(home, "x", "utf8");
  const result = applyFixes({ ...process.env, ASTRO_HOME: home });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("diretório");
});

test("applyFixes recusa ASTRO_HOME relativo sem criar nada", () => {
  const base = sandbox();
  const relative = `.astro-doctor-${process.pid}-${Date.now()}`;
  const result = applyFixes({ ...process.env, ASTRO_HOME: relative });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("absoluto");
  expect(existsSync(join(base, relative))).toBe(false);
  expect(existsSync(join(process.cwd(), relative))).toBe(false);
});

test("applyFixes recusa ASTRO_HOME absoluto com .. sem criar o destino resolvido", () => {
  const base = sandbox();
  // `..` literal: `join` normalizaria o segmento e o teste não exercitaria a guarda.
  const escape = `${base}${sep}..${sep}astro-doctor-escape-${process.pid}-${Date.now()}`;
  dirs.push(escape);
  const result = applyFixes({ ...process.env, ASTRO_HOME: escape });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("..");
  expect(existsSync(escape)).toBe(false);
});

test("applyFixes aceita ASTRO_HOME absoluto dentro do cwd, uma vez e idempotente", () => {
  const base = sandbox();
  const home = join(base, "state", "home");
  const env = { ...process.env, ASTRO_HOME: home };

  const first = applyFixes(env);
  expect(first.errors).toEqual([]);
  expect(first.applied).toHaveLength(1);
  expect(existsSync(home)).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(home).mode & 0o777).toBe(0o700);
  }

  const second = applyFixes(env);
  expect(second.errors).toEqual([]);
  expect(second.applied).toEqual([]);
});

test("applyFixes recusa ASTRO_HOME que é link simbólico e não escreve pelo link", () => {
  const base = sandbox();
  const target = join(base, "missing-target");
  const home = join(base, "linked-home");
  symlinkSync(target, home, process.platform === "win32" ? "junction" : "dir");

  const result = applyFixes({ ...process.env, ASTRO_HOME: home });
  expect(result.applied).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("link");
});

test("check da astro home falha quando o valor resolvido é inválido", () => {
  const report = runChecks(facts({
    astroHome: { path: ".astro", exists: false, writable: false, error: 'ASTRO_HOME precisa ser um caminho absoluto: .astro' },
  }));
  const check = report.checks.find((item) => item.label === "astro home");
  expect(check?.level).toBe("fail");
  expect(check?.detail).toContain("absoluto");
  expect(exitCode(report)).toBe(1);
});

test("sanitizeCheck redige também o label do check", () => {
  const secret = ["sk", "-", "live", "-", "SECRET", "123456789"].join("");
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: secret, credentialRef: "KEY" }],
    },
    env: { KEY: "present" },
  }));
  const text = lines(report);
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain(secret);
  expect(JSON.stringify(doctorJson(report))).not.toContain(secret);
});

test("leitura aceita ASTRO_HOME que é link simbólico e reporta o caminho real", () => {
  const base = sandbox();
  const projectCwd = sandbox();
  const real = join(base, "real-home");
  mkdirSync(real, { recursive: true });
  const link = join(base, "linked-home");
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");

  const collected = collectFacts(process.cwd(), {
    projectCwd,
    env: { ...process.env, ASTRO_HOME: link },
    checkPrivate: () => true,
  });
  expect(collected.config.path).toBe(join(projectCwd, "astro.config.json"));
  expect(collected.config.present).toBe(false);
  expect(collected.astroHome.error).toBeUndefined();
  expect(collected.astroHome.exists).toBe(true);
  expect(collected.astroHome.path).toBe(realpathSync(real));

  const report = runChecks(collected);
  const check = report.checks.find((item) => item.label === "astro home");
  expect(check?.level).toBe("ok");
  expect(exitCode(report)).toBe(0);
});

test("skills usam raízes injetadas e skill quebrada de projeto vira warn", () => {
  const projectCwd = sandbox();
  const projectRoot = join(projectCwd, ".astro", "skills");
  const userRoot = join(sandbox(), "skills");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  writeSkill(projectRoot, "projeto-quebrado", "sem frontmatter");
  writeSkill(userRoot, "user-ok", VALID_SKILL);

  const collected = collectFacts(process.cwd(), {
    projectCwd,
    projectSkillsRoot: projectRoot,
    env: { ...process.env, ASTRO_HOME: join(sandbox(), "other-home") },
    checkPrivate: () => true,
    userSkillsRoot: userRoot,
  });
  expect(collected.config.path).toBe(join(projectCwd, "astro.config.json"));
  expect(collected.skills?.project).toBe(0);
  expect(collected.skills?.user).toBe(1);
  expect(collected.skills?.warnings.join(" ")).toContain("projeto-quebrado");
  const check = runChecks(collected).checks.find((item) => item.label === "skills");
  expect(check?.level).toBe("warn");
  expect(exitCode(runChecks(collected))).toBe(0);
});

test("caminhos relativos de config e skills seguem a base declarada", () => {
  const projectCwd = sandbox();
  const configPath = join(projectCwd, "custom.json");
  writeFileSync(configPath, onlineConfig("https://proj.example/v1"), "utf8");
  const projectRoot = join(projectCwd, ".astro", "skills");
  writeSkill(projectRoot, "project-ok", VALID_SKILL);
  const userRoot = join(sandbox(), "skills");
  writeSkill(userRoot, "user-ok", VALID_SKILL);

  const collected = collectFacts(process.cwd(), {
    projectCwd,
    configPath: "custom.json",
    projectSkillsRoot: join(".astro", "skills"),
    userSkillsRoot: relative(process.cwd(), userRoot),
    env: { ...process.env, ASTRO_HOME: join(sandbox(), "other-home") },
    checkPrivate: () => true,
  });
  expect(collected.config.path).toBe(configPath);
  expect(collected.config.present).toBe(true);
  expect(collected.skills?.project).toBe(1);
  expect(collected.skills?.user).toBe(1);
});

test("skills válidas na raiz do usuário são contadas", () => {
  const projectCwd = sandbox();
  const projectRoot = join(projectCwd, ".astro", "skills");
  const userRoot = join(sandbox(), "skills");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  writeSkill(userRoot, "ok", VALID_SKILL);

  const collected = collectFacts(process.cwd(), {
    projectCwd,
    projectSkillsRoot: projectRoot,
    env: { ...process.env, ASTRO_HOME: join(sandbox(), "other-home") },
    checkPrivate: () => true,
    userSkillsRoot: userRoot,
  });
  expect(collected.skills).toEqual({ project: 0, user: 1, warnings: [] });
  const check = runChecks(collected).checks.find((item) => item.label === "skills");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("1 do usuário");
});

test("raiz padrão de skills do projeto vem do $ASTRO_HOME declarado (#468)", () => {
  const projectCwd = sandbox();
  const home = sandbox();
  writeSkill(projectSkillsRoot(projectCwd, { ASTRO_HOME: home }), "home-skill", VALID_SKILL);
  const collected = collectFacts(process.cwd(), {
    projectCwd,
    env: { ...process.env, ASTRO_HOME: home },
    userSkillsRoot: join(sandbox(), "skills"),
    checkPrivate: () => true,
  });
  expect(collected.skills?.project).toBe(1);
});

test("$ASTRO_HOME relativo não diverge do loader (resolvido pelo cwd do processo) (#468)", () => {
  const projectCwd = join(sandbox(), "nested", "proj");
  mkdirSync(projectCwd, { recursive: true });
  const home = sandbox();
  const relativeHome = relative(process.cwd(), home);
  expect(relativeHome).not.toBe("");
  // The loader resolves the relative path against the process cwd, not the project.
  // The fixture is written via the absolute path: Bun 1.4.2 on win32 fails mkdirSync
  // with ENOENT on long relative paths; the loader itself always resolves before fs calls.
  writeSkill(resolve(projectSkillsRoot(projectCwd, { ASTRO_HOME: relativeHome })), "rel-skill", VALID_SKILL);
  const collected = collectFacts(process.cwd(), {
    projectCwd,
    env: { ...process.env, ASTRO_HOME: relativeHome },
    userSkillsRoot: join(sandbox(), "skills"),
    checkPrivate: () => true,
  });
  expect(collected.skills?.project).toBe(1);
});

test("config global malformada falha mesmo com config de projeto válida", () => {
  const home = sandbox();
  const projectCwd = sandbox();
  writeFileSync(join(home, "config.json"), "{not json", "utf8");
  writeFileSync(join(projectCwd, "astro.config.json"), onlineConfig("https://proj.example/v1"), "utf8");

  const collected = collectFacts(process.cwd(), {
    projectCwd,
    env: { ...process.env, ASTRO_HOME: home },
    checkPrivate: () => true,
  });
  expect(collected.config.global?.error).toBeString();
  const report = runChecks(collected);
  const check = report.checks.find((item) => item.label === "config global");
  expect(check?.level).toBe("fail");
  expect(exitCode(report)).toBe(1);
});

function onlineConfig(baseUrl: string, credentialRef = "ONLINE_KEY"): string {
  return JSON.stringify({
    providers: { proj: { kind: "openai-compat", baseUrl, credentialRef } },
    models: [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

function onlineEnv(): Record<string, string> {
  return { ASTRO_NO_GLOBAL_CONFIG: "1", ASTRO_HOME: join(sandbox(), "home"), ONLINE_KEY: "k" };
}

test("doctor offline não faz chamada de rede (fetch global e injetado)", async () => {
  const dir = sandbox();
  writeFileSync(join(dir, "astro.config.json"), onlineConfig("https://proj.example/v1"), "utf8");
  let hits = 0;
  const fetchLike = (async () => { hits += 1; return new Response("{}"); }) as unknown as typeof fetch;
  const original = globalThis.fetch;
  let globalHits = 0;
  globalThis.fetch = (async () => { globalHits += 1; return new Response("{}"); }) as unknown as typeof fetch;
  try {
    const report = await runDoctor(process.cwd(), {
      online: false, onlineCwd: dir, fetchLike, env: onlineEnv(),
    });
    expect(hits).toBe(0);
    expect(globalHits).toBe(0);
    expect(report.checks.some((check) => check.name === "online" || check.name.startsWith("provider:"))).toBe(false);
  } finally {
    globalThis.fetch = original;
  }
});

test("--online mapeia provider fora para fail e mantém timeout limitado", async () => {
  const dir = sandbox();
  writeFileSync(join(dir, "astro.config.json"), onlineConfig("https://proj.example/v1"), "utf8");
  const fetchLike = (async () => new Response("fora", { status: 503 })) as unknown as typeof fetch;

  const checks = await collectOnlineChecks(onlineEnv(), { onlineCwd: dir, fetchLike, timeoutMs: 50 });
  expect(checks.find((check) => check.label === "online")?.level).toBe("fail");
  const provider = checks.find((check) => check.label === "provider:proj");
  expect(provider?.level).toBe("fail");
  expect(provider?.detail).toContain("HTTP 503");
  expect(exitCode({ checks })).toBe(1);

  const hang = (async (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as unknown as typeof fetch;
  const started = Date.now();
  const timed = await collectOnlineChecks(onlineEnv(), { onlineCwd: dir, fetchLike: hang, timeoutMs: 20 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(timed.find((check) => check.label === "provider:proj")?.detail).toContain("timeout de 20ms");
});

test("--online sem config válida não faz rede", async () => {
  let hits = 0;
  const fetchLike = (async () => { hits += 1; return new Response("{}"); }) as unknown as typeof fetch;
  const missing = await collectOnlineChecks(onlineEnv(), { onlineCwd: sandbox(), fetchLike });
  expect(missing.find((check) => check.label === "online")?.level).toBe("ok");
  expect(missing[0]?.detail).toContain("sem rede");

  const dir = sandbox();
  writeFileSync(join(dir, "astro.config.json"), JSON.stringify({ providers: {} }), "utf8");
  const invalid = await collectOnlineChecks(onlineEnv(), { onlineCwd: dir, fetchLike });
  expect(invalid[0]?.level).toBe("warn");
  expect(invalid[0]?.detail).toContain("config inválida");
  expect(hits).toBe(0);
});

test("doctorJson expõe name/status/message com error no fail e mantém aliases", () => {
  const report = runChecks(facts({ bunVersion: "1.3.9" }));
  const json = doctorJson(report);
  const check = json.checks.find((item) => item.name === "bun");

  expect(check?.status).toBe("error");
  expect(check?.message).toContain("abaixo do mínimo");
  expect(check?.level).toBe("fail");
  expect(check?.label).toBe("bun");
  expect(exitCode(report)).toBe(1);
  expect(json.checks.find((item) => item.name === "dist")?.status).not.toBe("error");
});

test("doctorJson usa slug estável em name e label só para exibição", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json", present: true,
      providers: [{ id: "acme", credentialRef: "ACME_KEY" }],
      mcp: { servers: 0, enabled: 0, missingHeaderEnv: [] },
      global: { path: "~/.astro/config.json", present: true },
    },
    skills: { project: 0, user: 0, warnings: [] }, disk: { cwd: "/proj", writable: true },
  }));
  const byName = new Map(doctorJson(report).checks.map((check) => [check.name, check]));

  expect(byName.get("credential:acme")?.label).toBe("credencial acme");
  expect(byName.get("astroHome")?.label).toBe("astro home");
  expect(byName.get("configGlobal")?.label).toBe("config global");
  expect(byName.get("attachments")?.label).toBe("anexos");
  for (const name of ["dependencies", "mcp", "skills", "disk"]) expect(byName.has(name)).toBe(true);
  for (const check of byName.values()) expect(check.name).not.toContain(" ");
});

test("credencial vault:<id> é cofre local, não env ausente", () => {
  const report = runChecks(facts({
    config: {
      path: "astro.config.json",
      present: true,
      providers: [{ id: "p", credentialRef: "vault:cred-12345678" }],
    },
  }));
  const check = report.checks.find((item) => item.label === "credencial p");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("cofre");
  expect(check?.detail).not.toContain("ausente");
});

test("model check shows a provider override next to the catalog value (#625)", () => {
  const report = runChecks(facts({
    model: {
      ref: "codex/gpt-5.5",
      overrides: [{ field: "context", effective: "64000", catalog: "400000" }],
    },
  }));
  const check = report.checks.find((item) => item.name === "model");
  expect(check?.level).toBe("ok");
  expect(check?.detail).toContain("context 64000 (catalog 400000)");
  expect(exitCode(report)).toBe(0);
});

test("a malformed override fails the model check naming the field (#625)", () => {
  const report = runChecks(facts({
    modelErrors: [{
      ref: "codex/gpt-5.5",
      field: "efforts",
      reason: "reasoning requires at least one effort level",
      source: "override",
    }],
  }));
  const check = report.checks.find((item) => item.name === "model:codex/gpt-5.5");
  expect(check?.level).toBe("fail");
  expect(check?.detail).toContain("efforts");
  expect(exitCode(report)).toBe(1);
});

test("each recorded malformed offer is one fail check, active or not (#638)", () => {
  const report = runChecks(facts({
    model: {
      ref: "codex/gpt-5.5",
      overrides: [{ field: "context", effective: "64000", catalog: "400000" }],
    },
    modelErrors: [
      { ref: "nvidia/gpt-5.5", field: "efforts", reason: "reasoning requires at least one effort level", source: "override" },
      { ref: "openrouter/openai/gpt-4o-mini", field: "maxOutput", reason: "cannot exceed context 4000", source: "override" },
    ],
  }));
  const checks = report.checks.filter((item) => item.name.startsWith("model:"));
  expect(checks.map((item) => item.name)).toEqual(["model:nvidia/gpt-5.5", "model:openrouter/openai/gpt-4o-mini"]);
  expect(checks.every((item) => item.level === "fail")).toBe(true);
  expect(exitCode(report)).toBe(1);
});

test("a malformed offer names its source: catalog fact or provider override (#638)", () => {
  const report = runChecks(facts({
    modelErrors: [{ ref: "demo/gpt-5.5", field: "maxOutput", reason: "must be a positive integer (got 0)", source: "catalog" }],
  }));
  const check = report.checks.find((item) => item.name === "model:demo/gpt-5.5");
  expect(check?.detail).toContain("malformed catalog fact");
  expect(check?.detail).not.toContain("malformed provider override");
});

function catalogConfig(agentModel: string, modelId: string): string {
  return JSON.stringify({
    providers: { demo: { kind: "openai-compat", baseUrl: "https://demo.example/v1", credentialRef: "DEMO_KEY" } },
    models: [{ provider: "demo", id: modelId, tags: ["writing-code"], context: 8192 }],
    agent: { model: agentModel, maxSteps: 2, tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  });
}

test("collectFacts carries the active model overrides from the composed catalog (#638)", () => {
  const projectCwd = sandbox();
  writeFileSync(join(projectCwd, "astro.config.json"), catalogConfig("demo/gpt-5.5", "gpt-5.5"), "utf8");
  const catalog = [composeEntry({
    key: "demo", name: "Demo", kind: "openai-compat",
    models: [{ ref: "gpt-5.5", price: null, free: false, overrides: { context: 64_000 } }],
  })];
  const collected = collectFacts(process.cwd(), {
    projectCwd,
    catalog,
    env: { ...process.env, ASTRO_NO_GLOBAL_CONFIG: "1", ASTRO_HOME: join(projectCwd, "home") },
    checkPrivate: () => true,
  });
  expect(collected.model?.ref).toBe("demo/gpt-5.5");
  expect(collected.model?.overrides[0]).toEqual({ field: "context", effective: "64000", catalog: "400000" });
});

test("collectFacts reports a malformed offer that is not the active model (#638)", () => {
  const projectCwd = sandbox();
  const active = "meta/llama-3.3-70b-instruct";
  writeFileSync(join(projectCwd, "astro.config.json"), catalogConfig(`demo/${active}`, active), "utf8");
  const catalog = [composeEntry({
    key: "demo", name: "Demo", kind: "openai-compat",
    models: [
      { ref: "gpt-5.5", price: null, free: false, overrides: { reasoning: true, efforts: [] } },
      { ref: "meta/llama-3.3-70b-instruct", price: null, free: false },
    ],
  })];
  const collected = collectFacts(process.cwd(), {
    projectCwd,
    catalog,
    env: { ...process.env, ASTRO_NO_GLOBAL_CONFIG: "1", ASTRO_HOME: join(projectCwd, "home") },
    checkPrivate: () => true,
  });
  expect(collected.model).toBeUndefined();
  const report = runChecks(collected);
  const checks = report.checks.filter((item) => item.name.startsWith("model:"));
  expect(checks.map((item) => item.name)).toEqual(["model:demo/gpt-5.5"]);
  expect(checks[0]?.detail).toContain("efforts");
  expect(exitCode(report)).toBe(1);
});

test("no model check without an override, so doctor output is unchanged (#625)", () => {
  const report = runChecks(facts());
  expect(report.checks.some((item) => item.name === "model")).toBe(false);
});

test("modelFactFor reads the active model card from the composed catalog (#625)", () => {
  const entry = composeEntry({
    key: "demo", name: "Demo", kind: "openai-compat",
    models: [
      { ref: "gpt-5.5", price: null, free: false, overrides: { context: 64000 } },
      { ref: "meta/llama-3.3-70b-instruct", price: null, free: false },
    ],
  });
  const fact = modelFactFor("demo/gpt-5.5", [entry]);
  expect(fact?.overrides[0]).toEqual({ field: "context", effective: "64000", catalog: "400000" });
  expect(modelFactFor("demo/meta/llama-3.3-70b-instruct", [entry])).toBeUndefined();
  expect(modelFactFor("unknown/gpt-5.5", [entry])).toBeUndefined();
});
