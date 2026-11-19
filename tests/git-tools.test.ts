import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Auditor } from "../src/audit";
import { pathCandidatesOf } from "../src/permissions";
import { ToolExecutor } from "../src/tools/executor";
import { gitDiffTool, gitStatusTool } from "../src/tools/git";
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

async function status(cwd: string, input: object = {}): Promise<StatusOutput> {
  const result = await gitStatusTool.execute(input, ctx(cwd));
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.output) as StatusOutput;
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
    const staged = await gitDiffTool.execute({ staged: true }, ctx(cwd));
    expect(staged.isError).toBeFalsy();
    expect(staged.output).toContain("+dois");

    const worktree = await gitDiffTool.execute({}, ctx(cwd));
    expect(worktree.isError).toBeFalsy();
    expect(worktree.output).not.toContain("+dois");
    expect(worktree.output).toContain("truncated=false");
  });

  testGit("base de 40 hex compara com o commit", async () => {
    const cwd = repo({ "a.txt": "um\n" });
    const base = git(cwd, "rev-parse", "HEAD").trim();
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    const result = await gitDiffTool.execute({ base }, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("+dois");
    expect(result.output).toContain(`base=${base}`);
  });

  testGit("path restringe o diff", async () => {
    const cwd = repo({ "a.txt": "um\n", "b.txt": "um\n" });
    writeFileSync(join(cwd, "a.txt"), "dois\n");
    writeFileSync(join(cwd, "b.txt"), "dois\n");
    const result = await gitDiffTool.execute({ path: "a.txt" }, ctx(cwd));
    expect(result.output).toContain("a.txt");
    expect(result.output).not.toContain("b.txt");
  });

  testGit("diff acima do cap trunca com marcador explícito", async () => {
    const cwd = repo({ "grande.txt": "linha\n" });
    const linhas = Array.from({ length: 2000 }, (_, i) => `linha ${i} ${"x".repeat(80)}`);
    writeFileSync(join(cwd, "grande.txt"), linhas.join("\n") + "\n");
    const result = await gitDiffTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("truncated=true");
    expect(result.output).toContain("diff truncado");
    expect(result.output.length).toBeLessThanOrEqual(10_000);
  });

  testGit("binary reporta binário, não conteúdo", async () => {
    const cwd = repo({ "bin.dat": Buffer.from([0, 1, 2, 3]) });
    writeFileSync(join(cwd, "bin.dat"), Buffer.from([0, 9, 8, 7]));
    const result = await gitDiffTool.execute({}, ctx(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.output.toLowerCase()).toContain("binary");
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
