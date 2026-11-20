import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Auditor } from "../src/audit";
import { pathCandidatesOf } from "../src/permissions";
import { ToolExecutor } from "../src/tools/executor";
import { gitDiffTool, gitEnv, gitStatusTool } from "../src/tools/git";
import type { ToolContext } from "../src/tools/types";

const IDENTITY = [
  "-c", "user.name=Astro Test",
  "-c", "user.email=astro@test.local",
  "-c", "commit.gpgsign=false",
];

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...IDENTITY, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} falhou: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

function repo(files: Record<string, string | Uint8Array>): string {
  const cwd = mkdtempSync(join(tmpdir(), "astro-git-"));
  git(cwd, "init", "-q");
  writeFiles(cwd, files);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "init");
  return cwd;
}

function writeFiles(cwd: string, files: Record<string, string | Uint8Array>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = join(cwd, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

const ctx = (cwd: string): ToolContext => ({ cwd, run: "r1", agent: "coder" });

/** Git em Windows/CI pode passar de 5 s sob carga: timeout explícito por teste. */
const testGit = (name: string, fn: () => Promise<void> | void): void => {
  test(name, { timeout: 30_000 }, fn);
};

interface Entry {
  index: string;
  worktree: string;
  path: string;
}

interface StatusOutput {
  clean: boolean;
  entries: Entry[];
  total?: number;
  truncated?: boolean;
}

interface DiffOutput {
  staged: boolean;
  base: string | null;
  truncated: boolean;
  diff: string;
}

async function status(cwd: string, input: object = {}): Promise<StatusOutput> {
  const result = await gitStatusTool.execute(input, ctx(cwd));
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.output) as StatusOutput;
}

async function diff(cwd: string, input: object = {}): Promise<DiffOutput> {
  const result = await gitDiffTool.execute(input, ctx(cwd));
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.output) as DiffOutput;
}

describe("git_status", () => {
  testGit("manifesto é read-only (read_common, sem efeitos)", () => {
    expect(gitStatusTool.manifest.name).toBe("git_status");
    expect(gitStatusTool.manifest.class).toBe("read_common");
    expect(gitStatusTool.manifest.permission).toBe("read");
    expect(gitStatusTool.manifest.sideEffects).toBe("none");
    expect(gitStatusTool.manifest.idempotent).toBe(true);
    expect(gitStatusTool.manifest.retryable).toBe(true);
    const params = gitStatusTool.manifest.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.properties).toHaveProperty("path");
    expect(params.required).toHaveLength(0);
  });

  testGit("árvore limpa devolve clean e nenhuma entrada", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    expect(await status(cwd)).toEqual({ clean: true, entries: [] });
  });

  testGit("arquivo modificado separa index e worktree", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    expect(await status(cwd)).toEqual({
      clean: false,
      entries: [{ index: ".", worktree: "M", path: "a.txt" }],
    });
  });

  testGit("staged e worktree no mesmo arquivo viram MM", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    git(cwd, "add", "a.txt");
    writeFileSync(join(cwd, "a.txt"), "três\n");
    expect(await status(cwd)).toEqual({
      clean: false,
      entries: [{ index: "M", worktree: "M", path: "a.txt" }],
    });
  });

  testGit("rename aparece como from -> to", async () => {
    const cwd = repo({ "velho.txt": "conteúdo\n" });
    git(cwd, "mv", "velho.txt", "novo.txt");
    expect(await status(cwd)).toEqual({
      clean: false,
      entries: [{ index: "R", worktree: ".", path: "velho.txt -> novo.txt" }],
    });
  });

  testGit("path restringe ao subdiretório e não escapa do cwd (I-11)", async () => {
    const cwd = repo({ "a.txt": "um\n", "sub/b.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    writeFileSync(join(cwd, "sub", "b.txt"), "dois\n");
    expect((await status(cwd, { path: "sub" })).entries).toEqual([
      { index: ".", worktree: "M", path: "sub/b.txt" },
    ]);
    const escaped = await gitStatusTool.execute({ path: "../" }, ctx(cwd));
    expect(escaped.isError).toBe(true);
    expect(escaped.output).toContain("fora");
  });

  testGit("cwd em subdiretório não mostra arquivos fora dele (I-11)", async () => {
    const cwd = repo({ "a.txt": "um\n", "sub/b.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    writeFileSync(join(cwd, "sub", "b.txt"), "dois\n");
    const sub = join(cwd, "sub");
    expect(await status(sub)).toEqual({
      clean: false,
      entries: [{ index: ".", worktree: "M", path: "b.txt" }],
    });
  });

  testGit("cap em bytes preserva total/truncated com paths longos", async () => {
    const cwd = repo({ "seed.txt": "x\n" });
    for (let i = 0; i < 500; i++) {
      const name = `${"y".repeat(120)}-${String(i).padStart(3, "0")}.txt`;
      writeFileSync(join(cwd, name), "x");
    }
    const raw = await gitStatusTool.execute({}, ctx(cwd));
    expect(raw.isError).toBeFalsy();
    const result = JSON.parse(raw.output) as StatusOutput;
    expect(Buffer.byteLength(raw.output, "utf8")).toBeLessThanOrEqual(10_000);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
    expect(result.entries.length).toBeLessThan(500);
    expect(result.clean).toBe(false);
  });

  testGit("diretório sem repositório devolve erro tipado, não throw", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-nogit-"));
    const result = await gitStatusTool.execute({}, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.code).toBe("git_not_repo");
  });
});

describe("git_diff", () => {
  testGit("manifesto é read-only e aceita path, staged e base", () => {
    expect(gitDiffTool.manifest.name).toBe("git_diff");
    expect(gitDiffTool.manifest.class).toBe("read_common");
    expect(gitDiffTool.manifest.permission).toBe("read");
    expect(gitDiffTool.manifest.sideEffects).toBe("none");
    const params = gitDiffTool.manifest.parameters as {
      properties: Record<string, unknown>;
    };
    expect(params.properties).toHaveProperty("path");
    expect(params.properties).toHaveProperty("staged");
    expect(params.properties).toHaveProperty("base");
  });

  testGit("worktree e staged são diferentes", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    git(cwd, "add", "a.txt");
    const staged = await diff(cwd, { staged: true });
    expect(staged.diff).toContain("+dois");
    expect(staged.staged).toBe(true);

    const worktree = await diff(cwd);
    expect(worktree.diff).not.toContain("+dois");
    expect(worktree.truncated).toBe(false);
    expect(worktree.diff).toBe("");
  });

  testGit("base de 40 hex compara com o commit", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    const base = git(cwd, "rev-parse", "HEAD").trim();
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    const result = await diff(cwd, { base });
    expect(result.diff).toContain("+dois");
    expect(result.base).toBe(base);
  });

  testGit("path restringe o diff", async () => {
    const cwd = repo({ "a.txt": "um\n", "b.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    writeFileSync(join(cwd, "b.txt"), "dois\n");
    const result = await diff(cwd, { path: "a.txt" });
    expect(result.diff).toContain("a.txt");
    expect(result.diff).not.toContain("b.txt");
  });

  testGit("diff acima do cap trunca com marcador explícito", async () => {
    const cwd = repo({ "grande.txt": "linha\n" });
    const linhas = Array.from({ length: 2000 }, (_, i) => `linha ${i} ${"x".repeat(80)}`);
    writeFileSync(join(cwd, "grande.txt"), linhas.join("\n") + "\n");
    const raw = await gitDiffTool.execute({}, ctx(cwd));
    expect(raw.isError).toBeFalsy();
    const result = JSON.parse(raw.output) as DiffOutput;
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain("diff truncado");
    expect(Buffer.byteLength(raw.output, "utf8")).toBeLessThanOrEqual(10_000);
  });

  testGit("binary reporta (binário), não conteúdo", async () => {
    const cwd = repo({ "bin.dat": Buffer.from([0, 1, 2, 3]) });
    writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 9, 8, 7]));
    const result = await diff(cwd);
    expect(result.diff).toContain("(binário)");
    expect(result.diff).not.toContain("Binary files");
  });

  testGit(".gitattributes forçando binário devolve (binário)", async () => {
    const cwd = repo({ "forcado.txt": "texto\n", ".gitattributes": "forcado.txt -diff\n" });
    writeFileSync(join(cwd, "forcado.txt"), "CONTEUDO-NAO-DEVE-SAIR\n");
    const result = await diff(cwd, { path: "forcado.txt" });
    expect(result.diff).toContain("(binário)");
    expect(result.diff).not.toContain("CONTEUDO-NAO-DEVE-SAIR");
  });

  testGit("base com metacaractere de shell é recusada sem spawnar git", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    const marker = join(cwd, "pwned");
    const result = await gitDiffTool.execute({ base: `HEAD; touch ${marker}` }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("base inválida");
    expect(() => readFileSync(marker)).toThrow();
  });

  testGit("ref com flag é recusado (sem injeção de opção)", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    const result = await gitDiffTool.execute({ ref: "--upload-pack=touch pwned" }, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("base inválida");
  });

  testGit("path absoluto ou com flag é recusado", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    const absolute = await gitDiffTool.execute({ path: join(cwd, "a.txt") }, ctx(cwd));
    expect(absolute.isError).toBe(true);
    const flag = await gitDiffTool.execute({ path: "--no-index" }, ctx(cwd));
    expect(flag.isError).toBe(true);
    expect(flag.output).toContain("path inválido");
  });

  testGit("diretório sem repositório devolve erro tipado, não throw", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "astro-nogit-"));
    const result = await gitDiffTool.execute({}, ctx(cwd));
    expect(result.isError).toBe(true);
    expect(result.code).toBe("git_not_repo");
  });

  testGit("BLOCKER 1: magic pathspec é recusado em cwd de subdiretório", async () => {
    const cwd = repo({ "outside.txt": "inicial\n", "sub/inside.txt": "um\n" });
    writeFileSync(join(cwd, "outside.txt"), "SEGREDO-TOPO\n");
    const sub = join(cwd, "sub");
    const specs = [":(top)outside.txt", ":/outside.txt", ":(exclude)outside.txt", ":(glob)outside.txt"];
    for (const spec of specs) {
      for (const tool of [gitStatusTool, gitDiffTool]) {
        const result = await tool.execute({ path: spec }, ctx(sub));
        expect(result.isError).toBe(true);
        expect(result.output).toContain("path inválido");
        expect(result.output).not.toContain("SEGREDO-TOPO");
      }
    }
  });

  testGit("BLOCKER 2: git_diff recusa conteúdo hard-block", async () => {
    const cwd = repo({
      "ok.txt": "um\n",
      ".env": "CHAVE=segredo-env\n",
      "certs/id_rsa": "SEGREDO-ID-RSA\n",
    });
    writeFileSync(join(cwd, ".env"), "CHAVE=segredo-env-novo\n");
    writeFileSync(join(cwd, "certs", "id_rsa"), "SEGREDO-ID-RSA-NOVO\n");
    for (const input of [{}, { path: "certs" }, { path: ".env" }]) {
      const result = await gitDiffTool.execute(input, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.code).toBe("path_hard_blocked");
      expect(result.output).not.toContain("segredo-env");
      expect(result.output).not.toContain("SEGREDO-ID-RSA");
    }
  });

  test.skipIf(process.platform !== "win32")(
    "BLOCKER 2: junction para fora do repo não vaza hard-block",
    { timeout: 30_000 },
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "astro-git-outside-"));
      writeFileSync(join(outside, "id_rsa"), "SEGREDO-JUNCTION-1\n");
      const cwd = mkdtempSync(join(tmpdir(), "astro-git-junction-"));
      git(cwd, "init", "-q");
      writeFileSync(join(cwd, "seed.txt"), "x\n");
      symlinkSync(outside, join(cwd, "link"), "junction");
      git(cwd, "add", "seed.txt");
      git(cwd, "add", "-f", "link/id_rsa");
      git(cwd, "commit", "-q", "-m", "init");
      writeFileSync(join(outside, "id_rsa"), "SEGREDO-JUNCTION-2\n");

      const result = await gitDiffTool.execute({}, ctx(cwd));
      expect(result.isError).toBe(true);
      expect(result.code).toBe("path_hard_blocked");
      expect(result.output).not.toContain("SEGREDO-JUNCTION");
    },
  );

  testGit("GIT_CONFIG_PARAMETERS e GIT_COMMON_DIR são neutralizados", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    const common = mkdtempSync(join(tmpdir(), "astro-git-common-"));
    const env = {
      ...process.env,
      GIT_CONFIG_PARAMETERS: "'diff.noprefix=true'",
      GIT_COMMON_DIR: common,
    };
    const result = await gitDiffTool.execute({}, { ...ctx(cwd), env });
    expect(result.isError).toBeFalsy();
    const out = JSON.parse(result.output) as DiffOutput;
    expect(out.diff).toContain("diff --git a/a.txt b/a.txt");
    expect(out.diff).toContain("+dois");
  });
});

describe("ambiente do git", () => {
  testGit("GIT_LITERAL_PATHSPECS e DROP_ENV neutralizam injeção", () => {
    const env = gitEnv({
      ...ctx(process.cwd()),
      env: {
        GIT_LITERAL_PATHSPECS: "0",
        GIT_CONFIG_PARAMETERS: "'diff.noprefix=true'",
        GIT_COMMON_DIR: "/tmp/outro",
        SAFE_VALUE: "1",
      },
    });
    expect(env.GIT_LITERAL_PATHSPECS).toBe("1");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
    expect(env).not.toHaveProperty("GIT_COMMON_DIR");
    expect(env.SAFE_VALUE).toBe("1");
  });
});

describe("git tools no executor", () => {
  testGit("sem path o gate classifica o próprio cwd (ADR-0027)", () => {
    expect(pathCandidatesOf({ name: "git_status", input: {} })).toEqual(["."]);
    expect(pathCandidatesOf({ name: "git_diff", input: {} })).toEqual(["."]);
  });

  testGit("cwd hard-block é negado antes de rodar git", async () => {
    const savedHome = process.env.ASTRO_HOME;
    const home = mkdtempSync(join(tmpdir(), "astro-git-hb-"));
    process.env.ASTRO_HOME = home;
    try {
      const cwd = join(home, "projeto");
      mkdirSync(cwd);
      const tools = [gitStatusTool, gitDiffTool];
      const executor = new ToolExecutor({
        tools,
        allow: tools.map((tool) => tool.manifest.name),
        audit: new Auditor(join(cwd, "audit.jsonl")),
        permissionMode: "bypass",
      });
      for (const name of ["git_status", "git_diff"]) {
        const result = await executor.run(ctx(cwd), { id: "1", name, arguments: "{}" });
        expect(result.isError).toBe(true);
        expect(result.output).toContain("path_hard_blocked");
      }
    } finally {
      if (savedHome === undefined) delete process.env.ASTRO_HOME;
      else process.env.ASTRO_HOME = savedHome;
    }
  });

  testGit("rodam sem aprovação no modo ask e auditam só tool.call/tool.result", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    const tools = [gitStatusTool, gitDiffTool];
    const auditPath = join(cwd, ".astro", "audit.jsonl");
    const executor = new ToolExecutor({
      tools,
      allow: tools.map((tool) => tool.manifest.name),
      audit: new Auditor(auditPath),
      permissionMode: "ask",
    });

    const statusResult = await executor.run(ctx(cwd), {
      id: "1",
      name: "git_status",
      arguments: "{}",
    });
    expect(statusResult.isError).toBeFalsy();
    const diffResult = await executor.run(ctx(cwd), {
      id: "2",
      name: "git_diff",
      arguments: "{}",
    });
    expect(diffResult.isError).toBeFalsy();

    const events = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { tipo: string });
    expect(events.map((event) => event.tipo)).toEqual([
      "tool.call", "tool.result", "tool.call", "tool.result",
    ]);
  });
});
