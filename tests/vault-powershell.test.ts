import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { resolvePowerShell } from "../src/vault";

const SYSTEM_EXE = join("System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "astro-powershell-"));
  const systemRoot = join(root, "windows");
  const exe = join(systemRoot, SYSTEM_EXE);
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  const planted = join(root, "planted");
  mkdirSync(planted);
  writeFileSync(join(planted, "powershell.exe"), "attacker-controlled");
  return { root, systemRoot, exe, planted };
}

describe("PowerShell resolution (#605, I-03)", () => {
  test("uses the absolute system binary and never PATH", () => {
    const { systemRoot, exe, planted } = fixture();
    const env = {
      SystemRoot: systemRoot,
      PATH: `${planted}${delimiter}${process.env.PATH ?? ""}`,
    } as NodeJS.ProcessEnv;

    expect(resolvePowerShell(env, "win32")).toBe(exe);
  });

  test("falls back to windir when SystemRoot is absent", () => {
    const { systemRoot, exe, planted } = fixture();
    const env = { windir: systemRoot, PATH: planted } as NodeJS.ProcessEnv;

    expect(resolvePowerShell(env, "win32")).toBe(exe);
  });

  test("refuses when the system binary is missing instead of resolving PATH", () => {
    const { root, planted } = fixture();
    const env = { SystemRoot: join(root, "empty"), PATH: planted } as NodeJS.ProcessEnv;

    expect(() => resolvePowerShell(env, "win32")).toThrow(/PowerShell/);
    expect(() => resolvePowerShell({ PATH: planted } as NodeJS.ProcessEnv, "win32")).toThrow(/PowerShell/);
  });
});
