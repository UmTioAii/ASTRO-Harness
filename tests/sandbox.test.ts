import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateConfig, ConfigError } from "../src/config";
import * as runCommandModule from "../src/tools/run-command";
import {
  runCommandTool,
  configureRunCommand,
  detectDockerAvailable,
  dockerInfoSupportsLinuxContainers,
  resolveSandboxSetting,
  sanitizedEnv,
} from "../src/tools/run-command";

/**
 * `dockerArgv` (slice 4) é inspecionado sem Docker real. Acesso via namespace
 * para o RED falhar por asserção — e não por erro de carga de módulo — antes
 * de a implementação existir.
 */
type DockerArgvFn = (
  containerName: string,
  cwd: string,
  command: string,
  opts?: { env?: NodeJS.ProcessEnv; protectedPaths?: readonly string[] },
) => { argv: string[]; cleanup: () => void };
const dockerArgv = (runCommandModule as unknown as { dockerArgv: DockerArgvFn }).dockerArgv;

const ctx = (cwd: string) => ({ cwd, run: "r1", agent: "coder" });

const baseConfig = {
  providers: { openai: { kind: "openai-compat", baseUrl: "http://localhost", credentialRef: "OPENAI_API_KEY" } },
  models: [{ provider: "openai", id: "gpt-4o-mini", tags: ["writing-code", "tools"], context: 128000 }],
  agent: { model: "openai/gpt-4o-mini", maxSteps: 12, tools: ["run_command"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

describe("config tools.run_command.sandbox (F4-6)", () => {
  test("sem tools: sandbox efetivo ligado (fail-closed)", () => {
    const cfg = validateConfig(structuredClone(baseConfig));
    expect(resolveSandboxSetting(cfg.tools?.run_command?.sandbox)).toBe(true);
  });

  test("tools.run_command sem sandbox → ligado (opt-out precisa ser explícito)", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: {} };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(true);
  });

  test("tools.run_command.sandbox: false é opt-out explícito", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: false } };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(false);
    expect(resolveSandboxSetting(cfg.tools?.run_command?.sandbox)).toBe(false);
  });

  test("tools.run_command.sandbox: true aceito", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: true } };
    const cfg = validateConfig(raw);
    expect(cfg.tools?.run_command?.sandbox).toBe(true);
  });

  test("tools.run_command.sandbox inválido → ConfigError", () => {
    const raw = structuredClone(baseConfig) as Record<string, unknown>;
    raw.tools = { run_command: { sandbox: "yes" } };
    expect(() => validateConfig(raw)).toThrow(ConfigError);
  });
});

describe("sanitizedEnv (I-03)", () => {
  test("remove DB_PASS, SSH_PEM e PASSPHRASE sem remover nomes inocentes", () => {
    const env = sanitizedEnv({
      DB_PASS: "db-secret",
      SSH_PEM: "pem-secret",
      DEPLOY_PASSPHRASE: "pass-secret",
      GIT_AUTHOR_NAME: "autora",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("DB_PASS");
    expect(env).not.toHaveProperty("SSH_PEM");
    expect(env).not.toHaveProperty("DEPLOY_PASSPHRASE");
    expect(env.GIT_AUTHOR_NAME).toBe("autora");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("remove AUTHORIZATION e variantes; mantém identidade git (I-03)", () => {
    const env = sanitizedEnv({
      AUTHORIZATION: "Bearer aaa",
      HTTP_AUTHORIZATION: "Bearer bbb",
      PROXY_AUTHORIZATION: "Bearer ccc",
      WWW_AUTHORIZATION: "Bearer ddd",
      GIT_AUTHOR_NAME: "autora",
      GIT_COMMITTER_NAME: "autor",
      GIT_AUTHOR_EMAIL: "a@b.c",
      GIT_COMMITTER_EMAIL: "a@b.c",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("AUTHORIZATION");
    expect(env).not.toHaveProperty("HTTP_AUTHORIZATION");
    expect(env).not.toHaveProperty("PROXY_AUTHORIZATION");
    expect(env).not.toHaveProperty("WWW_AUTHORIZATION");
    expect(env.GIT_AUTHOR_NAME).toBe("autora");
    expect(env.GIT_COMMITTER_NAME).toBe("autor");
    expect(env.GIT_AUTHOR_EMAIL).toBe("a@b.c");
    expect(env.GIT_COMMITTER_EMAIL).toBe("a@b.c");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("run_command sandbox (F4-6)", () => {
  afterEach(() => {
    configureRunCommand({ sandbox: false });
  });

  test("detecção só aceita engine Linux (Windows containers não rodam alpine/--read-only)", () => {
    expect(dockerInfoSupportsLinuxContainers("24.0.7|linux\n")).toBe(true);
    expect(dockerInfoSupportsLinuxContainers("24.0.7|windows\n")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("|linux")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("24.0.7")).toBe(false);
    expect(dockerInfoSupportsLinuxContainers("")).toBe(false);
  });

  test("sandbox=false: recusa com sandbox_required_for_shell e não faz spawn no host (ADR-0027 slice 4, I-11/I-19)", async () => {
    configureRunCommand({ sandbox: false });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const originalSpawn = Bun.spawn;
    let spawnCalls = 0;
    (Bun as unknown as { spawn: unknown }).spawn = () => {
      spawnCalls += 1;
      throw new Error("spawn bloqueado neste teste");
    };
    try {
      const result = await runCommandTool.execute({ command: "echo marker-nao-roda" }, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("sandbox_required_for_shell");
      // a recusa não ecoa o comando (I-03) e nenhum spawn acontece no host
      expect(result.output).not.toContain("marker-nao-roda");
      expect(spawnCalls).toBe(0);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = originalSpawn;
    }
  });

  test("sandbox=true sem Docker → recusa clara (sem downgrade silencioso)", async () => {
    configureRunCommand({ sandbox: true });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const docker = await detectDockerAvailable();
    const result = await runCommandTool.execute({ command: "echo ok" }, ctx(cwd));
    if (!docker) {
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Docker");
      expect(result.output).toContain("sandbox");
    } else {
      // neste ambiente Docker existe; o comando roda contido
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("ok");
    }
  }, 60_000);

  test("sandbox=true: detecção de Docker é cacheada", async () => {
    const first = await detectDockerAvailable();
    const second = await detectDockerAvailable();
    expect(first).toBe(second);
  });

  test("sandbox=true com Docker: comando malicioso não escapa", async () => {
    configureRunCommand({ sandbox: true });
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-"));
    const docker = await detectDockerAvailable();
    if (!docker) {
      // Windows CI sem Docker: teste de contenção é no-op aqui; coberto no Ubuntu
      expect(true).toBe(true);
      return;
    }

    // rede desabilitada: wget falha
    const net = await runCommandTool.execute(
      { command: "wget -T 2 http://example.invalid 2>&1 || echo net-failed" },
      ctx(cwd),
    );
    expect(net.output).toContain("net-failed");

    // rootfs read-only: escrever fora do cwd falha
    const fsEscape = await runCommandTool.execute(
      { command: "touch /etc/astro-evil 2>&1 || echo fs-blocked" },
      ctx(cwd),
    );
    expect(fsEscape.output).toContain("fs-blocked");

    // cwd continua gravável
    const writeOk = await runCommandTool.execute(
      { command: "echo dentro > sandbox-ok.txt && cat sandbox-ok.txt" },
      ctx(cwd),
    );
    expect(writeOk.isError).toBeFalsy();
    expect(writeOk.output).toContain("dentro");

    // env do host não vaza para dentro do container
    const envProbe = await runCommandTool.execute(
      { command: "sh -c 'echo KEY=${ASTRO_TEST_SECRET:-vazio}'" },
      ctx(cwd),
    );
    expect(envProbe.output).toContain("vazio");
  }, 60_000);
});

describe("dockerArgv: máscaras de hard-block no container (ADR-0027 slice 4)", () => {
  const volumesOf = (argv: string[]): string[] => {
    const vols: string[] = [];
    for (let i = 0; i < argv.length - 1; i += 1) {
      if (argv[i] === "--volume") vols.push(argv[i + 1] ?? "");
    }
    return vols;
  };
  const hasRoMask = (argv: string[], target: string): boolean =>
    volumesOf(argv).some((v) => v.endsWith(`:${target}:ro`));

  test("máscaras ro stat-based para .env, .git e subdir; artifactRoot mascarado; --tmpfs /tmp; git off; imagem default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-mask-"));
    const artifact = mkdtempSync(join(tmpdir(), "astro-sb-art-"));
    writeFileSync(join(cwd, ".env"), "DUMMY=1\n");
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "sub"));
    writeFileSync(join(cwd, "sub", ".env"), "DUMMY=2\n");
    writeFileSync(join(cwd, "ok.txt"), "normal\n");
    const plan = dockerArgv("astro-test", cwd, "echo hi", {
      env: { ...process.env, ASTRO_ARTIFACT_ROOT: artifact },
    });
    try {
      const { argv } = plan;
      const workdir = resolve(cwd);
      // rootfs read-only + /tmp como tmpfs rw,noexec,nosuid
      expect(argv).toContain("--read-only");
      const tmpfs = argv.indexOf("--tmpfs");
      expect(tmpfs).toBeGreaterThan(-1);
      expect(argv[tmpfs + 1]).toBe("/tmp:rw,noexec,nosuid");
      // git indisponível no container
      expect(argv).toContain("GIT_DIR=/dev/null");
      expect(argv).toContain("GIT_CONFIG_NOSYSTEM=1");
      // máscaras ro (stat-based) para hard-block dentro do cwd
      expect(hasRoMask(argv, join(workdir, ".env"))).toBe(true);
      expect(hasRoMask(argv, join(workdir, ".git"))).toBe(true);
      expect(hasRoMask(argv, join(workdir, "sub", ".env"))).toBe(true);
      // artifactRoot mascarado onde estiver (ADR-0026: nunca fonte de shell)
      expect(hasRoMask(argv, realpathSync(artifact))).toBe(true);
      // path normal não é mascarado; cwd segue montado read-write
      expect(hasRoMask(argv, join(workdir, "ok.txt"))).toBe(false);
      expect(volumesOf(argv)).toContain(`${workdir}:${workdir}`);
      // imagem default carrega o toolchain
      expect(argv).toContain("oven/bun:1.4.2");
    } finally {
      plan.cleanup();
    }
  });

  test(".git como arquivo (worktree) vira máscara de arquivo vazio ro; cleanup remove a fonte", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-gitfile-"));
    writeFileSync(join(cwd, ".git"), "gitdir: C:/outro/repo\n");
    const plan = dockerArgv("astro-test", cwd, "echo hi", { env: { ...process.env } });
    const workdir = resolve(cwd);
    const suffix = `:${join(workdir, ".git")}:ro`;
    const vol = volumesOf(plan.argv).find((v) => v.endsWith(suffix));
    expect(vol).toBeDefined();
    const source = vol!.slice(0, vol!.length - suffix.length);
    expect(existsSync(source)).toBe(true);
    expect(statSync(source).isFile()).toBe(true);
    expect(readFileSync(source, "utf8")).toBe("");
    plan.cleanup();
    expect(existsSync(source)).toBe(false);
  });

  test("ASTRO_DOCKER_IMAGE sobrescreve a imagem (produção fixa por digest via env)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-img-"));
    const plan = dockerArgv("astro-test", cwd, "echo hi", {
      env: { ...process.env, ASTRO_DOCKER_IMAGE: "example.invalid/astro-sandbox:test" },
    });
    try {
      expect(plan.argv).toContain("example.invalid/astro-sandbox:test");
      expect(plan.argv).not.toContain("oven/bun:1.4.2");
    } finally {
      plan.cleanup();
    }
  });

  test("ASTRO_ARTIFACT_ROOT inexistente não quebra o argv", () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-sb-noart-"));
    const missing = join(cwd, "nao-existe");
    const plan = dockerArgv("astro-test", cwd, "echo hi", {
      env: { ...process.env, ASTRO_ARTIFACT_ROOT: missing },
    });
    try {
      expect(plan.argv[0]).toBe("docker");
      expect(hasRoMask(plan.argv, missing)).toBe(false);
    } finally {
      plan.cleanup();
    }
  });
});