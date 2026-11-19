import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/core/config";
import { bootSession, declaredModelFor, openSession } from "../src/tui/run";
import { saveTuiConfig } from "../src/tui/theme";

const tempCwd = (): string => mkdtempSync(join(tmpdir(), "astro-tui-boot-"));

describe("bootstrap da TUI (T2, #197)", () => {
  test("aplica o modelo gravado; inválido cai no default; outros erros propagam", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const seen: Array<string | undefined> = [];
    expect(openSession((saved) => { seen.push(saved); return saved ?? "default"; }, cwd)).toBe("p/m2");
    expect(seen).toEqual(["p/m2"]);

    saveTuiConfig(cwd, { lastModel: "p/ghost" });
    const fallback = openSession((saved) => {
      if (saved === "p/ghost") throw new ConfigError("modelo desconhecido");
      return saved ?? "p/m1";
    }, cwd);
    expect(fallback).toBe("p/m1");
    expect(() => openSession(() => { throw new Error("boom"); }, tempCwd())).toThrow("boom");
  });

  test("modelo salvo não troca o agent.model declarado (#497)", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const seen: Array<string | undefined> = [];
    expect(openSession((saved) => { seen.push(saved); return saved ?? "p/m1"; }, cwd, "p/m1")).toBe("p/m1");
    expect(seen).toEqual([undefined]); // não tentou o modelo salvo
  });

  test("agent.model declarado só na camada global também vence o lastModel (#497)", () => {
    const home = mkdtempSync(join(tmpdir(), "astro-tui-home-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
      models: [
        { provider: "p", id: "m1", tags: ["writing-code"], context: 8192 },
        { provider: "p", id: "m2", tags: ["writing-code"], context: 8192 },
      ],
      agent: { model: "p/m1", maxSteps: 2, tools: [] },
      paths: { ledger: "l", audit: "a" },
    }));
    const cwd = tempCwd(); // sem astro.config.json no projeto
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const declared = declaredModelFor(join(cwd, "astro.config.json"), { env: { ASTRO_HOME: home } });
    expect(declared).toBe("p/m1");
    const seen: Array<string | undefined> = [];
    expect(bootSession((saved) => { seen.push(saved); return saved ?? "p/m1"; }, cwd, { declaredModel: declared })).toBe("p/m1");
    expect(seen).toEqual([undefined]);
  });

  test("bootSession com --provider ignora o modelo salvo mesmo sem declarado (#497)", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const seen: Array<string | undefined> = [];
    expect(bootSession((saved) => { seen.push(saved); return saved ?? "p/m1"; }, cwd, { provider: "p" })).toBe("p/m1");
    expect(seen).toEqual([undefined]);
  });

  test("bootSession com --provider ignora o modelo salvo (#497)", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    const seen: Array<string | undefined> = [];
    expect(bootSession((saved) => { seen.push(saved); return saved ?? "p/m1"; }, cwd, {
      declaredModel: "p/m1",
      provider: "p",
    })).toBe("p/m1");
    expect(seen).toEqual([undefined]);
  });

  test("bootSession sem config declarada usa o modelo salvo (#497)", () => {
    const cwd = tempCwd();
    saveTuiConfig(cwd, { lastModel: "p/m2" });
    expect(bootSession((saved) => saved ?? "p/m1", cwd, {})).toBe("p/m2");
  });
});
