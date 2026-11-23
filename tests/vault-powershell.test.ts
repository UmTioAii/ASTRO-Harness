import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePowerShell } from "../src/vault";

const EXE = join("System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "astro-powershell-"));
  roots.push(root);
  const systemRoot = join(root, "windows");
  const exe = join(systemRoot, EXE);
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  const planted = join(root, "planted");
  mkdirSync(planted);
  writeFileSync(join(planted, "powershell.exe"), "attacker-controlled");
  return { root, systemRoot, exe, planted };
}

const resolveFrom = (systemRoot: string) => resolvePowerShell({ platform: "win32", roots: [systemRoot] });

describe("PowerShell resolution (#605, I-03)", () => {
  test("uses the trusted root and ignores env SystemRoot/windir", () => {
    const { systemRoot, exe, planted } = fixture();
    expect(resolveFrom(systemRoot)).toBe(exe);
    const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
    process.env.SystemRoot = planted;
    process.env.windir = planted;
    try {
      if (process.platform === "win32") {
        expect(resolvePowerShell({ platform: "win32" })).not.toContain(planted);
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
});
