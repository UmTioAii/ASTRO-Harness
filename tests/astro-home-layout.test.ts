import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Auditor } from "../src/audit";
import { SessionApi } from "../src/chat/session-api";
import { astroHomePath } from "../src/astro-home";
import {
  PROJECT_KEY_MAX_BYTES,
  globalTuiConfigPath,
  projectDataDir,
  projectKey,
  projectSkillsRoot,
  projectTuiConfigPath,
  skillsUserRoot,
} from "../src/home-layout";
import { runSkillsCommand } from "../src/skills/cli";
import { resolveTaskSkill } from "../src/skills/executor";
import { verifySkill } from "../src/skills/installer";
import { loadTuiConfig, saveTuiConfig } from "../src/tui/theme";

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const tempHome = (): { home: string; env: Record<string, string> } => {
  const home = tempDir("astro-layout-home-");
  return { home, env: { ASTRO_HOME: home } };
};

const SKILL = (name: string): string =>
  `---\nname: ${name}\ndescription: Skill ${name}\nversion: 1.0.0\npermissions:\n  tools: [read_file]\n---\nPrompt de ${name}.\n`;

function skillDir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL(name));
  return dir;
}

function makeRecord(id: string) {
  return {
    schemaVersion: 1 as const, id, startedAt: "2026-11-19T12:00:00.000Z",
    model: "provider/model", messages: [{ role: "user" as const, content: "oi" }],
    turns: 1, tokensIn: 10, tokensOut: 5, costUsd: null,
  };
}

function writeProject(cwd: string, env: Record<string, string>, text: string): void {
  const file = projectTuiConfigPath(cwd, env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

const caseInsensitivePlatform = (): boolean => process.platform === "win32" || process.platform === "darwin";

describe("layout de $ASTRO_HOME (#468)", () => {
  test("as duas raízes de skills saem de $ASTRO_HOME, nunca de homedir() ou do cwd", () => {
    const { env } = tempHome();
    const cwd = tempDir("astro-layout-proj-");
    expect(skillsUserRoot(env)).toBe(join(env.ASTRO_HOME!, "skills"));
    expect(projectSkillsRoot(cwd, env)).toBe(join(projectDataDir(cwd, env), "skills"));
    expect(projectDataDir(cwd, env).startsWith(join(env.ASTRO_HOME!, "projects"))).toBe(true);
    // o cwd entra como chave, não como raiz: nada é resolvido dentro dele
    expect(projectSkillsRoot(cwd, env).startsWith(cwd)).toBe(false);
  });

  test("$ASTRO_HOME sobrescrito move o layout inteiro", () => {
    const first = tempHome();
    const second = tempHome();
    const cwd = tempDir("astro-layout-override-");
    expect(projectDataDir(cwd, first.env)).not.toBe(projectDataDir(cwd, second.env));
    expect(projectDataDir(cwd, second.env).startsWith(second.env.ASTRO_HOME!)).toBe(true);
    expect(astroHomePath(second.env)).toBe(second.env.ASTRO_HOME!);
  });

  test("a chave do projeto é determinística e dois projetos nunca compartilham diretório", () => {
    expect(projectKey("/a/b")).toBe(projectKey("/a/b"));
    expect(projectKey("/a/b")).not.toBe(projectKey("/a/b/c"));
    expect(projectKey("/a/b")).not.toBe(projectKey("/a/bc"));
    // separador e sublinhado literais não colidem (escape distinto)
    expect(projectKey("/a/b")).not.toBe(projectKey("/a_b"));
    const { env } = tempHome();
    expect(projectDataDir("/a/b", env)).not.toBe(projectDataDir("/a/b/c", env));
  });

  test("hash só acima do limite do filesystem e determinístico", () => {
    // caminho base já canônico: o prefixo da plataforma entra na conta do teto
    const base = projectKey("/base");
    const padding = PROJECT_KEY_MAX_BYTES - Buffer.byteLength(base) - 2;
    const atLimit = `/base/${"a".repeat(padding)}`;
    expect(Buffer.byteLength(projectKey(atLimit))).toBe(PROJECT_KEY_MAX_BYTES);
    expect(projectKey(atLimit).startsWith("sha256-")).toBe(false);
    const overLimit = `${atLimit}a`;
    expect(projectKey(overLimit)).toMatch(/^sha256-[0-9a-f]{32}$/);
    expect(projectKey(overLimit)).toBe(projectKey(overLimit));
    expect(projectKey(overLimit)).not.toBe(projectKey(`${overLimit}b`));
  });

  test("barra invertida é separador só no win32: no POSIX é literal", () => {
    if (process.platform === "win32") return; // no win32 `a\b` e `a/b` são o mesmo caminho
    expect(projectKey("/a\\b")).not.toBe(projectKey("/a/b"));
    expect(projectKey("/a\\b")).toContain("_x5c");
  });

  test("caixa do projeto só dobra onde o filesystem não diferencia (win32/darwin)", () => {
    const upper = projectKey("/home/Dev/Proj");
    const lower = projectKey("/home/dev/proj");
    if (caseInsensitivePlatform()) expect(upper).toBe(lower);
    else expect(upper).not.toBe(lower);
  });

  test("escape de byte usa dois dígitos: 0x01 seguido de 'f' não colide com 0x1f", () => {
    if (process.platform === "win32") return; // win32 não aceita controle no nome
    expect(projectKey("/\u0001f")).not.toBe(projectKey("/\u001f"));
    expect(projectKey("/\u0001f")).toContain("_x01");
    expect(projectKey("/\u001f")).toContain("_x1f");
  });
});

describe("sessões sob $ASTRO_HOME (#468)", () => {
  test("sessões do projeto ficam na chave do projeto e nada nasce no cwd", () => {
    const { env } = tempHome();
    const cwd = tempDir("astro-layout-session-");
    const dir = projectDataDir(cwd, env);
    const api = new SessionApi(dir);
    try {
      expect(api.databasePath).toBe(join(dir, "sessions.db"));
      api.save(makeRecord("s1"));
      expect(api.list().map((item) => item.id)).toEqual(["s1"]);
    } finally {
      api.close();
    }
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(cwd, ".astro"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(api.databasePath).mode & 0o777).toBe(0o600);
    }
    // o loader relê da mesma raiz: a sessão não some ao reabrir
    const reopened = new SessionApi(dir);
    try {
      expect(reopened.load("s1").id).toBe("s1");
    } finally {
      reopened.close();
    }
  });

  test("cada projeto tem a própria raiz de sessões", () => {
    const { env } = tempHome();
    const one = tempDir("astro-layout-p1-");
    const two = tempDir("astro-layout-p2-");
    const first = projectDataDir(one, env);
    const second = projectDataDir(two, env);
    expect(first).not.toBe(second);
    expect(first.startsWith(env.ASTRO_HOME!)).toBe(true);
    expect(second.startsWith(env.ASTRO_HOME!)).toBe(true);
  });

  test("raiz de sessões com junction para fora do home é recusada antes de criar (I-11)", () => {
    const { home, env } = tempHome();
    const cwd = tempDir("astro-layout-session-escape-");
    const outside = tempDir("astro-layout-session-outside-");
    mkdirSync(join(home, "projects"), { recursive: true });
    symlinkSync(outside, projectDataDir(cwd, env), process.platform === "win32" ? "junction" : "dir");

    expect(() => new SessionApi(projectDataDir(cwd, env), { home })).toThrow(/ASTRO_HOME/);
    expect(existsSync(join(outside, "sessions.db"))).toBe(false);
  });

  test("purga de cópia legada não apaga arquivo fora do home (I-11)", () => {
    const { home, env } = tempHome();
    const cwd = tempDir("astro-layout-session-purge-");
    const dir = projectDataDir(cwd, env);
    const outside = tempDir("astro-layout-purge-outside-");
    const created = new SessionApi(dir, { home });
    created.save(makeRecord("s1"));
    created.close();

    // `sessions/` é um junction: a purga não pode seguir para fora
    symlinkSync(outside, join(dir, "sessions"), process.platform === "win32" ? "junction" : "dir");
    const stamped = join(outside, "2026-11-19T12-00-00-000Z-s1.json");
    writeFileSync(stamped, JSON.stringify(makeRecord("s1")), "utf8");
    const api = new SessionApi(dir, { home });
    try {
      expect(api.delete("s1")).toBe(true);
    } finally {
      api.close();
    }
    expect(existsSync(stamped)).toBe(true);
  });
});

describe("tema global com override por projeto (#468)", () => {
  test("precedência: global < override do projeto < default", () => {
    const { home, env } = tempHome();
    const cwd = tempDir("astro-layout-theme-");
    const other = tempDir("astro-layout-theme-outro-");
    writeFileSync(globalTuiConfigPath(env), JSON.stringify({ theme: "light", favoriteModels: ["p/a"] }), "utf8");

    expect(loadTuiConfig(cwd, env)).toEqual({ theme: "light", favoriteModels: ["p/a"] });
    saveTuiConfig(cwd, { theme: "contrast" }, env);
    expect(loadTuiConfig(cwd, env)).toMatchObject({ theme: "contrast", favoriteModels: ["p/a"] });
    // o override grava só o que mudou, sem copiar a camada global
    expect(JSON.parse(readFileSync(projectTuiConfigPath(cwd, env), "utf8"))).toEqual({ theme: "contrast" });
    // o global continua valendo nos outros projetos
    expect(loadTuiConfig(other, env).theme).toBe("light");
    // arquivo de override inválido cai na camada global, não em erro
    writeFileSync(projectTuiConfigPath(cwd, env), "{", "utf8");
    expect(loadTuiConfig(cwd, env).theme).toBe("light");
    expect(existsSync(join(cwd, ".astro"))).toBe(false);
    expect(home.startsWith(tmpdir())).toBe(true);
  });

  test("override que escapa do $ASTRO_HOME é recusado na escrita e ignorado na leitura (I-11)", () => {
    const { home, env } = tempHome();
    const cwd = tempDir("astro-layout-theme-escape-");
    const outside = tempDir("astro-layout-theme-outside-");
    writeFileSync(globalTuiConfigPath(env), JSON.stringify({ theme: "light" }), "utf8");
    mkdirSync(join(home, "projects"), { recursive: true });
    symlinkSync(outside, projectDataDir(cwd, env), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(outside, "tui.json"), JSON.stringify({ theme: "contrast" }), "utf8");

    expect(loadTuiConfig(cwd, env).theme).toBe("light");
    expect(() => saveTuiConfig(cwd, { theme: "contrast" }, env)).toThrow(/ASTRO_HOME/);
  });

  test("recusa não cria diretório fora do home (I-11)", () => {
    const { home, env } = tempHome();
    const cwd = tempDir("astro-layout-theme-mkdir-");
    const outside = tempDir("astro-layout-theme-mkdir-out-");
    // `projects` inteiro é um junction: nenhuma criação pode acontecer antes da guarda
    symlinkSync(outside, join(env.ASTRO_HOME!, "projects"), process.platform === "win32" ? "junction" : "dir");

    expect(() => saveTuiConfig(cwd, { theme: "light" }, env)).toThrow(/ASTRO_HOME/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(home, "projects", projectKey(cwd)))).toBe(false);
  });

  test("lista do projeto vence a global, inclusive quando é vazia", () => {
    const { env } = tempHome();
    const cwd = tempDir("astro-layout-theme-list-");
    writeFileSync(
      globalTuiConfigPath(env),
      JSON.stringify({ theme: "light", favoriteModels: ["p/a"], recentModels: ["p/r"] }),
      "utf8",
    );
    writeProject(cwd, env, JSON.stringify({ favoriteModels: [] }));
    expect(loadTuiConfig(cwd, env)).toEqual({ theme: "light", favoriteModels: [], recentModels: ["p/r"] });

    // gravar a lista vazia também vence a global (limpar favoritos no projeto)
    saveTuiConfig(cwd, { favoriteModels: [] }, env);
    expect(loadTuiConfig(cwd, env).favoriteModels).toEqual([]);
  });
});

describe("loaders leem a raiz nova (#468)", () => {
  test("a skill do usuário vem de $ASTRO_HOME/skills e não de <cwd>/.astro/skills", () => {
    const { env } = tempHome();
    const cwd = tempDir("astro-layout-skill-");
    skillDir(skillsUserRoot(env), "deploy");
    skillDir(join(cwd, ".astro", "skills"), "legado");
    const audit = new Auditor(join(cwd, "audit.jsonl"));
    const base = { cwd, allow: ["read_file"], audit, run: "r1", agent: "main", env };

    expect(resolveTaskSkill("/deploy", base)).toContain("Prompt de deploy.");
    expect(() => resolveTaskSkill("/legado", base)).toThrow(/não encontrada/);
  });

  test("install grava na raiz de skills do projeto sob $ASTRO_HOME", async () => {
    const { env } = tempHome();
    const cwd = tempDir("astro-layout-install-");
    const source = skillDir(tempDir("astro-layout-src-"), "deploy");
    const lines: string[] = [];
    const code = await runSkillsCommand(["install", source], {
      cwd, env, auditPath: join(env.ASTRO_HOME!, "audit.jsonl"), out: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(verifySkill(projectSkillsRoot(cwd, env), "deploy").ok).toBe(true);
    expect(existsSync(join(cwd, ".astro", "skills"))).toBe(false);
  });

  test("install cria home, chave do projeto e raiz de skills com 0700 (POSIX)", async () => {
    if (process.platform === "win32") return;
    const home = join(tempDir("astro-layout-modes-"), "home");
    const env = { ASTRO_HOME: home };
    const cwd = tempDir("astro-layout-modes-proj-");
    const source = skillDir(tempDir("astro-layout-modes-src-"), "deploy");
    await runSkillsCommand(["install", source], {
      cwd, env, auditPath: join(tempDir("astro-layout-modes-audit-"), "audit.jsonl"), out: () => {},
    });
    for (const dir of [home, join(home, "projects"), projectDataDir(cwd, env), projectSkillsRoot(cwd, env)]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });
});
