import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDataDir, projectTuiConfigPath } from "../src/home-layout";
import { THEMES, getThemeColors, isTheme, loadTuiConfig, nextTheme, saveTuiConfig } from "../src/tui/theme";

/** Cada caso tem home e cwd próprios: o estado da TUI mora em `$ASTRO_HOME`. */
function envs(): { cwd: string; env: Record<string, string> } {
  return {
    cwd: mkdtempSync(join(tmpdir(), "astro-tui-theme-")),
    env: { ASTRO_HOME: mkdtempSync(join(tmpdir(), "astro-tui-theme-home-")) },
  };
}

describe("configuração da TUI (T2, #197)", () => {
  test("sem arquivo ou JSON inválido cai no tema dark", () => {
    const first = envs();
    expect(loadTuiConfig(first.cwd, first.env)).toEqual({ theme: "dark" });
    const broken = envs();
    writeFileSync(projectTuiConfigPath(broken.cwd, broken.env), "{", "utf8");
    expect(loadTuiConfig(broken.cwd, broken.env)).toEqual({ theme: "dark" });
  });

  test("salva tema e último modelo preservando um ao outro", () => {
    const { cwd, env } = envs();
    saveTuiConfig(cwd, { theme: "light" }, env);
    saveTuiConfig(cwd, { lastModel: "p/m2" }, env);
    expect(loadTuiConfig(cwd, env)).toEqual({ theme: "light", lastModel: "p/m2" });
    expect(nextTheme("light")).toBe("contrast"); // ciclo dark -> light -> contrast (#64)
    expect(getThemeColors("dark").accent).toBe("cyan");
  });

  test("favoritos e recentes persistem e ignoram entradas inválidas", () => {
    const { cwd, env } = envs();
    saveTuiConfig(cwd, { favoriteModels: ["p/a", "p/a", ""], recentModels: ["p/c", "p/c"] }, env);
    expect(loadTuiConfig(cwd, env)).toEqual({ theme: "dark", favoriteModels: ["p/a"], recentModels: ["p/c"] });
    const broken = envs();
    writeFileSync(
      projectTuiConfigPath(broken.cwd, broken.env),
      JSON.stringify({ theme: "light", favoriteModels: ["p/a", 1, ""] }),
      "utf8",
    );
    expect(loadTuiConfig(broken.cwd, broken.env)).toEqual({ theme: "light", favoriteModels: ["p/a"] });
  });

  test("recusa estado do projeto que escapa do $ASTRO_HOME (I-11)", () => {
    const { cwd, env } = envs();
    const outside = mkdtempSync(join(tmpdir(), "astro-tui-theme-outside-"));
    mkdirSync(join(env.ASTRO_HOME!, "projects"), { recursive: true });
    symlinkSync(outside, projectDataDir(cwd, env), process.platform === "win32" ? "junction" : "dir");
    expect(() => saveTuiConfig(cwd, { theme: "light" }, env)).toThrow();
    expect(loadTuiConfig(cwd, env)).toEqual({ theme: "dark" });
  });
});

describe("/theme e alto contraste (#64)", () => {
  test("THEMES, isTheme e nextTheme cobrem os três temas em ciclo", () => {
    expect(THEMES).toEqual(["dark", "light", "contrast"]);
    expect(isTheme("contrast")).toBe(true);
    expect(isTheme("light")).toBe(true);
    expect(isTheme("neon")).toBe(false);
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("contrast");
    expect(nextTheme("contrast")).toBe("dark");
  });

  test("contrast persiste no estado do projeto; tema inválido no arquivo cai em dark", () => {
    const { cwd, env } = envs();
    saveTuiConfig(cwd, { theme: "contrast" }, env);
    expect(loadTuiConfig(cwd, env)).toEqual({ theme: "contrast" });
    const bad = envs();
    writeFileSync(projectTuiConfigPath(bad.cwd, bad.env), JSON.stringify({ theme: "neon" }), "utf8");
    expect(loadTuiConfig(bad.cwd, bad.env)).toEqual({ theme: "dark" });
  });

  test("o tema de alto contraste usa cores brilhantes", () => {
    expect(getThemeColors("contrast")).toEqual({ accent: "whiteBright", warning: "yellowBright", error: "redBright" });
    expect(getThemeColors("dark").accent).toBe("cyan");
  });
});
