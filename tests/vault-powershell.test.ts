import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePowerShell } from "../src/vault";

const SYSTEM_EXE = join("System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "astro-powershell-"));
  roots.push(root);
  const systemRoot = join(root, "windows");
  const exe = join(systemRoot, SYSTEM_EXE);
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  const planted = join(root, "planted");
  mkdirSync(planted);
  writeFileSync(join(planted, "powershell.exe"), "attacker-controlled");
  return { root, systemRoot, exe, planted };
}

const resolveFrom = (systemRoot: string) =>
  resolvePowerShell({ platform: "win32", roots: [systemRoot] });

describe("PowerShell resolution (#605, I-03)", () => {
  test("uses the trusted system root", () => {
    const { systemRoot, exe } = fixture();
    expect(resolveFrom(systemRoot)).toBe(exe);
  });

  test("ignores SystemRoot/windir from the environment", () => {
    const { planted } = fixture();
    const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    process.env.SystemRoot = planted;
    process.env.windir = planted;
    try {
      if (process.platform === "win32") {
        const exe = resolvePowerShell({ platform: "win32" });
        expect(exe).not.toContain(planted);
        expect(exe.endsWith("powershell.exe")).toBe(true);
      } else {
        // No real Windows root on this host: refuse instead of reading env.
        expect(() => resolvePowerShell({ platform: "win32" })).toThrow(/PowerShell/);
      }
    } finally {
      if (saved.SystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = saved.SystemRoot;
      if (saved.windir === undefined) delete process.env.windir;
      else process.env.windir = saved.windir;
    }
  });

  test("refuses when no trusted root has the system binary", () => {
    const { root, planted } = fixture();
    expect(() => resolvePowerShell({ platform: "win32", roots: [join(root, "empty"), planted] }))
      .toThrow(/PowerShell/);
  });

  test("refuses a relative trusted root", () => {
    expect(() => resolvePowerShell({ platform: "win32", roots: ["windows"] }))
      .toThrow(/absolute/);
  });
});
