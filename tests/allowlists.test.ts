import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ALLOWLIST_ENTRIES,
  allowlistLoadEvents,
  validateAllowlistFlags,
} from "../src/allowlists";
import { AllowlistInvalidError } from "../src/path-class";
import { Auditor } from "../src/audit";
import { ToolExecutor } from "../src/tools/executor";
import { readFileTool } from "../src/tools/read-file";
import { dockerArgv } from "../src/tools/run-command";

const dir = (): string => mkdtempSync(join(tmpdir(), "astro-allow-"));

function setup() {
  const cwd = dir();
  const astroHome = dir();
  return { cwd, astroHome };
}

describe("validateAllowlistFlags (ADR-0027, #391 slice 5a): allowlists só via CLI, fail-closed", () => {
  test("--allow-critical sem --i-understand → allow_invalid (sai antes do run)", () => {
    const { cwd, astroHome } = setup();
    const file = join(cwd, "api_token.txt");
    writeFileSync(file, "x");
    try {
      validateAllowlistFlags(
        { allowCriticalRaw: [file], allowSensitiveRaw: [], iUnderstand: false },
        { cwd, astroHome },
      );
      expect.unreachable("deveria ter rejeitado");
    } catch (error) {
      expect(error).toBeInstanceOf(AllowlistInvalidError);
      expect((error as AllowlistInvalidError).code).toBe("allow_invalid");
    }
  });

  test("allow-critical válido (realpath absoluto de arquivo existente, tier configurável) → applied", () => {
    const { cwd, astroHome } = setup();
    mkdirSync(join(cwd, "tokens"));
    const file = join(cwd, "tokens", "api_token.txt");
    writeFileSync(file, "x");
    const out = validateAllowlistFlags(
      { allowCriticalRaw: [file], allowSensitiveRaw: [], iUnderstand: true },
      { cwd, astroHome },
    );
    expect(out.allowCritical).toHaveLength(1);
    expect(out.events).toContainEqual({ entry: out.allowCritical[0], result: "applied", origin: "cli", rule: "allow-critical" });
  });

  test("allow-critical relativo/glob/diretório/inexistente → allow_invalid", () => {
    const { cwd, astroHome } = setup();
    mkdirSync(join(cwd, "dir"));
    const file = join(cwd, "ok.txt");
    writeFileSync(file, "x");
    const bad = ["relativo.txt", join(cwd, "*.txt"), join(cwd, "dir"), join(cwd, "nao_existe_token.txt")];
    for (const entry of bad) {
      expect(() => validateAllowlistFlags(
        { allowCriticalRaw: [entry], allowSensitiveRaw: [], iUnderstand: true },
        { cwd, astroHome },
      )).toThrow(AllowlistInvalidError);
    }
  });

  test("allow-critical no tier imutável (.env) → allow_invalid, sem abortar por allow-sensitive", () => {
    const { cwd, astroHome } = setup();
    const env = join(cwd, ".env");
    writeFileSync(env, "X=1");
    expect(() => validateAllowlistFlags(
      { allowCriticalRaw: [env], allowSensitiveRaw: ["docs/*.md"], iUnderstand: true },
      { cwd, astroHome },
    )).toThrow(AllowlistInvalidError);
  });

  test("allow-critical acima de 64 entradas → allow_invalid", () => {
    const { cwd, astroHome } = setup();
    const entries = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => {
      const f = join(cwd, `api_token_${i}.txt`);
      writeFileSync(f, "x");
      return f;
    });
    expect(() => validateAllowlistFlags(
      { allowCriticalRaw: entries, allowSensitiveRaw: [], iUnderstand: true },
      { cwd, astroHome },
    )).toThrow(AllowlistInvalidError);
  });

  test("allow-critical que não casa o tier configurável → ignored (aviso), sem abortar", () => {
    const { cwd, astroHome } = setup();
    const file = join(cwd, "ok.txt");
    writeFileSync(file, "x");
    const out = validateAllowlistFlags(
      { allowCriticalRaw: [file], allowSensitiveRaw: [], iUnderstand: true },
      { cwd, astroHome },
    );
    expect(out.events).toContainEqual({ entry: out.allowCritical[0], result: "ignored", origin: "cli", rule: "allow-critical" });
  });

  test("allow-sensitive: glob normal applied; glob/literal que casa hard-block ou literal inexistente → ignored fail-closed", () => {
    const { cwd, astroHome } = setup();
    writeFileSync(join(cwd, ".env"), "X=1");
    writeFileSync(join(cwd, "ok.txt"), "x");
    const out = validateAllowlistFlags(
      { allowCriticalRaw: [], allowSensitiveRaw: ["docs/*.md", "*.pem", join(cwd, ".env"), join(cwd, "fantasma.txt")], iUnderstand: false },
      { cwd, astroHome },
    );
    expect(out.allowSensitive).toEqual(["docs/*.md"]);
    expect(out.events).toContainEqual({ entry: "docs/*.md", result: "applied", origin: "cli", rule: "allow-sensitive" });
    for (const entry of ["*.pem", join(cwd, ".env"), join(cwd, "fantasma.txt")]) {
      expect(out.events).toContainEqual({ entry, result: "ignored", origin: "cli", rule: "allow-sensitive" });
    }
  });

  test("allow-sensitive acima de 64 entradas → allow_invalid", () => {
    const { cwd, astroHome } = setup();
    const entries = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => `g${i}/*.md`);
    expect(() => validateAllowlistFlags(
      { allowCriticalRaw: [], allowSensitiveRaw: entries, iUnderstand: false },
      { cwd, astroHome },
    )).toThrow(AllowlistInvalidError);
  });

  test("allowlistLoadEvents deriva applied/ignored sem lançar (audit de load no run)", () => {
    const { cwd, astroHome } = setup();
    mkdirSync(join(cwd, "tokens"));
    const file = join(cwd, "tokens", "api_token.txt");
    writeFileSync(file, "x");
    const events = allowlistLoadEvents({ allowCritical: [file], allowSensitive: ["*.md"] }, { cwd, astroHome });
    expect(events).toContainEqual({ entry: file, result: "applied", origin: "cli", rule: "allow-critical" });
    expect(events).toContainEqual({ entry: "*.md", result: "applied", origin: "cli", rule: "allow-sensitive" });
    expect(allowlistLoadEvents({ allowCritical: [], allowSensitive: [] }, { cwd, astroHome })).toEqual([]);
  });
});

describe("gate de hard-block usa ctx.allowCritical (ADR-0027, #391 slice 5a)", () => {
  const SYNTH = ["s", "k", "-"].join("") + "live-synthetic-9f8e7d6c5b";

  function setup() {
    const cwd = dir();
    mkdirSync(join(cwd, "tokens"));
    writeFileSync(join(cwd, "tokens", "api_token.txt"), `CHAVE=${SYNTH}\n`);
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const executor = new ToolExecutor({
      tools: [readFileTool],
      allow: ["read_file"],
      audit,
      permissionMode: "bypass",
    });
    return { cwd, audit, executor };
  }

  const call = { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "tokens/api_token.txt" }) };

  test("sem allowCritical: hard-block continua deny em bypass", async () => {
    const { cwd, executor } = setup();
    const result = await executor.run({ cwd, run: "r1", agent: "a" }, call);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("path_hard_blocked");
  });

  test("com ctx.allowCritical: path liberado vira normal e audita security.allowlist_applied por match", async () => {
    const { cwd, audit, executor } = setup();
    const allow = join(cwd, "tokens", "api_token.txt");
    const result = await executor.run({ cwd, run: "r1", agent: "a", allowCritical: [allow] }, call);
    expect(result.isError).toBeFalsy();
    const applied = audit.readAll().filter((e) => e.tipo === "security.allowlist_applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.payload).toMatchObject({ result: "applied", origin: "cli", rule: "allow-critical" });
    expect(applied[0]!.payload?.entry).toBe(join("tokens", "api_token.txt")); // denyDisplayPath: relativo, sem conteúdo
    expect(JSON.stringify(audit.readAll())).not.toContain(SYNTH);
  });

  test("allowCritical no tier imutável continua allow_invalid no gate (fail-closed)", async () => {
    const { cwd, executor } = setup();
    writeFileSync(join(cwd, ".env"), `CHAVE=${SYNTH}\n`);
    const result = await executor.run(
      { cwd, run: "r1", agent: "a", allowCritical: [join(cwd, ".env")] },
      { id: "c2", name: "read_file", arguments: JSON.stringify({ path: ".env" }) },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("allow_invalid");
    expect(result.output).not.toContain(SYNTH);
  });
});

describe("sandbox: allowCritical não gera máscara para o path liberado (slice 5a)", () => {
  const volumeSpecs = (argv: string[]): string[] =>
    argv.flatMap((value, i) => (value === "--volume" ? [argv[i + 1] as string] : []));
  const hasRoMaskFor = (argv: string[], target: string): boolean =>
    volumeSpecs(argv).some((spec) => spec.endsWith(`:${target}:ro`));

  test("sem allowCritical a máscara existe; com allowCritical o path liberado não é mascarado", () => {
    const cwd = dir();
    mkdirSync(join(cwd, "tokens"));
    writeFileSync(join(cwd, "tokens", "api_token.txt"), "x");
    const target = join(cwd, "tokens", "api_token.txt");
    expect(hasRoMaskFor(dockerArgv("sb", { cwd }, "echo ok"), target)).toBe(true);
    expect(hasRoMaskFor(dockerArgv("sb", { cwd, allowCritical: [target] }, "echo ok"), target)).toBe(false);
    // .env continua mascarado mesmo com allowCritical de outro path
    writeFileSync(join(cwd, ".env"), "X=1");
    expect(hasRoMaskFor(dockerArgv("sb", { cwd, allowCritical: [target] }, "echo ok"), join(cwd, ".env"))).toBe(true);
  });
});

describe("CLI: flags de allowlist só em run/chat/tui e validadas antes do run", () => {
  const entry = join(import.meta.dir, "..", "src", "cli.ts");

  async function spawnCli(args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn([process.execPath, entry, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stderr };
  }

  test("run --allow-critical sem --i-understand → exit 1 com allow_invalid antes do run", async () => {
    const cwd = dir();
    const file = join(cwd, "api_token.txt");
    writeFileSync(file, "x");
    const { code, stderr } = await spawnCli(["run", "tarefa", "--allow-critical", file], cwd);
    expect(code).toBe(1);
    expect(stderr).toContain("allow_invalid");
  });

  test("run --i-understand sem --allow-critical → UsageError (exit 1, uso impresso)", async () => {
    const cwd = dir();
    const { code, stderr } = await spawnCli(["run", "tarefa", "--i-understand"], cwd);
    expect(code).toBe(1);
    expect(stderr).toContain("--i-understand");
    expect(stderr).toContain("Uso:");
  });

  test("flags fora de run/chat/tui → UsageError (opção desconhecida)", async () => {
    const cwd = dir();
    const { code, stderr } = await spawnCli(["health", "--allow-sensitive", "*.md"], cwd);
    expect(code).toBe(1);
    expect(stderr).toContain("opção desconhecida");
  });

  test("run --allow-critical <arquivo> --i-understand válido passa da validação (não sai com allow_invalid nem uso)", async () => {
    const cwd = dir();
    const file = join(cwd, "api_token.txt");
    writeFileSync(file, "x");
    const { code, stderr } = await spawnCli(["run", "tarefa", "--allow-critical", file, "--i-understand"], cwd);
    expect(stderr).not.toContain("allow_invalid");
    expect(stderr).not.toContain("Uso:");
    expect(code).toBe(1); // segue até a carga da config, que não existe no cwd de teste
    expect(stderr).toContain("erro:");
  });
});
