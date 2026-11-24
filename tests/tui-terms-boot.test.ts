import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeState, saveHomeState } from "../src/home-state";
import { SHELL_CONSENT_VERSION, saveShellConsent } from "../src/shell-consent";
import { TERMS_VERSION } from "../src/terms";
import { runCommandTool, setShellConsent } from "../src/tools/run-command";
import { bootTuiTerms } from "../src/tui/run";

const ISO = "2026-11-20T12:00:00.000Z";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "astro-tui-terms-"));
}

describe("boot da TUI: portão dos termos antes de qualquer escrita (#479)", () => {
  test("recusa: nenhuma config, sessão ou estado é criado antes do first-run", async () => {
    const root = workdir();
    const home = join(root, "home");
    const config = join(root, "astro.config.json");
    const globalConfig = join(home, "config.json");
    const state = join(home, "state.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(config, '{"agent":{"model":"p/m"}}\n');
    writeFileSync(globalConfig, '{"providers":{}}\n');
    saveHomeState({ version: 1, trust: { folders: [root] }, migrations: { providers: true, trust: true } }, state);
    const before = [config, globalConfig, state].map((path) => readFileSync(path, "utf8"));

    const boot = await bootTuiTerms({ env: { ASTRO_HOME: home }, ask: () => false });

    expect(boot).toEqual({ kind: "declined" });
    expect([config, globalConfig, state].map((path) => readFileSync(path, "utf8"))).toEqual(before);
    expect(existsSync(join(root, ".astro"))).toBe(false);
    expect(existsSync(join(home, "projects"))).toBe(false);
  });

  test("aceite: grava só o terms e devolve ready para seguir o boot", async () => {
    const root = workdir();
    const home = join(root, "home");
    const state = join(home, "state.json");
    saveHomeState({ version: 1, trust: { folders: [root] }, migrations: { providers: true, trust: false } }, state);

    const boot = await bootTuiTerms({
      env: { ASTRO_HOME: home },
      ask: () => true,
      now: () => new Date(ISO),
    });

    expect(boot).toEqual({ kind: "ready" });
    const saved = loadHomeState(state);
    expect(saved.terms).toEqual({ version: TERMS_VERSION, acceptedAt: ISO });
    expect(saved.trust).toEqual({ folders: [root] });
    expect(saved.migrations).toEqual({ providers: true, trust: false });
  });

  test("sem canal interativo: segue sem aceite e sem criar o estado", async () => {
    const root = workdir();
    const home = join(root, "home");

    const boot = await bootTuiTerms({ env: { ASTRO_HOME: home } });

    expect(boot).toEqual({ kind: "unattended" });
    expect(existsSync(join(home, "state.json"))).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test("o consentimento de risco vem depois dos termos, grava os dois e a recusa desliga o shell", async () => {
    const root = workdir();
    const home = join(root, "home");
    const state = join(home, "state.json");
    saveHomeState({ version: 1, trust: { folders: [root] }, migrations: { providers: true, trust: false } }, state);

    const asked: string[] = [];
    const accepted = await bootTuiTerms({
      env: { ASTRO_HOME: home },
      ask: () => { asked.push("terms"); return true; },
      shellAsk: () => { asked.push("shell"); return true; },
      now: () => new Date(ISO),
    });
    expect(accepted).toEqual({ kind: "ready" });
    expect(asked).toEqual(["terms", "shell"]);
    const saved = loadHomeState(state);
    expect(saved.terms).toEqual({ version: TERMS_VERSION, acceptedAt: ISO });
    expect(saved.shell).toEqual({ version: SHELL_CONSENT_VERSION, acceptedAt: ISO });
    expect(saved.trust).toEqual({ folders: [root] });
    expect(saved.migrations).toEqual({ providers: true, trust: false });

    // A stale record declined: nothing is written and the session runs without the shell.
    saveShellConsent({ version: "0", acceptedAt: "2020-01-01T00:00:00.000Z" }, state);
    const before = readFileSync(state, "utf8");
    const declined = await bootTuiTerms({ env: { ASTRO_HOME: home }, ask: () => true, shellAsk: () => false });
    expect(declined).toEqual({ kind: "ready" });
    expect(readFileSync(state, "utf8")).toBe(before);
    try {
      const result = await runCommandTool.execute(
        { command: "echo consent" },
        { cwd: root, run: "r1", agent: "default", env: { ...process.env } },
      );
      expect(result.code).toBe("shell_consent_declined");
    } finally {
      setShellConsent("unrecorded");
    }
  });

  test("runTui: o portão roda antes do setup e de openSessionApi (#591)", () => {
    // O boot real precisa de TTY, Ink e sessão; o pin é sobre a ordem no arquivo.
    // O setup wizard (#611) grava config, então a recusa tem de acontecer antes dele.
    const source = readFileSync(join(import.meta.dir, "..", "src", "tui", "run.tsx"), "utf8");
    const gate = source.indexOf("bootTuiTerms({");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(source.indexOf("runSetup("));
    expect(gate).toBeLessThan(source.indexOf("openSessionApi("));
  });
});
