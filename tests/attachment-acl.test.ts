import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCheckPrivate, windowsAclIsPrivate } from "../src/attachments/acl";

/** `(Get-Acl C:\Users\Public).Sddl` num Windows pt-BR: IU recebe allow. */
const PUBLIC_SDDL =
  "O:SYG:SYD:PAI(A;OICIIO;FA;;;CO)(A;;0x1200af;;;S-1-5-3)(A;OICIIO;0x1301ff;;;S-1-5-3)(A;OICIIO;0x1301ff;;;IU)(A;;0x1200af;;;IU)(A;OICIIO;0x1301ff;;;SU)(A;;0x1200af;;;SU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

/** Forma de `(Get-Acl $env:TEMP).Sddl`: dono, SYSTEM, BA e SIDs de usuário. */
const TEMP_SDDL =
  "O:S-1-5-21-4106146630-3323356226-4044041718-1001G:S-1-5-21-4106146630-3323356226-4044041718-513D:AI(A;OICIID;0x1201bf;;;S-1-5-21-4106146630-3323356226-4044041718-1002)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;S-1-5-21-4106146630-3323356226-4044041718-1001)";

const acl = (...aces: string[]) => `O:SYG:SYD:PAI${aces.join("")}`;

describe("windowsAclIsPrivate", () => {
  test("recusa allow para Everyone/Users/Authenticated/Interactive (alias)", () => {
    for (const alias of ["WD", "BU", "AU", "IU"]) {
      expect(windowsAclIsPrivate(acl("(A;OICI;FA;;;SY)", `(A;OICI;FR;;;${alias})`))).toBe(false);
    }
  });

  test("recusa allow para os SIDs completos dos mesmos grupos", () => {
    for (const sid of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11", "S-1-5-4"]) {
      expect(windowsAclIsPrivate(acl("(A;OICI;FA;;;SY)", `(A;OICI;FR;;;${sid})`))).toBe(false);
    }
  });

  test("aceita ACL só com dono, SYSTEM e Administrators", () => {
    expect(
      windowsAclIsPrivate(
        acl("(A;OICI;FA;;;SY)", "(A;OICI;FA;;;BA)", "(A;OICI;FA;;;S-1-5-21-1-2-3-1001)"),
      ),
    ).toBe(true);
    expect(windowsAclIsPrivate(TEMP_SDDL)).toBe(true);
  });

  test("ACE de deny para Everyone não abre a ACL", () => {
    expect(windowsAclIsPrivate(acl("(D;;FR;;;WD)", "(A;OICI;FA;;;SY)", "(A;OICI;FA;;;BA)"))).toBe(true);
  });

  test("entrada vazia, sem ACE ou lixo falha fechado", () => {
    expect(windowsAclIsPrivate("")).toBe(false);
    expect(windowsAclIsPrivate("O:SYG:SYD:PAI")).toBe(false);
    expect(windowsAclIsPrivate("garbage")).toBe(false);
  });

  test("ACE malformado falha fechado", () => {
    expect(windowsAclIsPrivate("(A;OICI;FA;;)")).toBe(false);
  });

  test("fixture real de C:\\Users\\Public é recusada", () => {
    expect(windowsAclIsPrivate(PUBLIC_SDDL)).toBe(false);
  });
});

describe("defaultCheckPrivate", () => {
  test.skipIf(process.platform === "win32")("POSIX: raiz 0700 passa e ausente passa", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-acl-"));
    try {
      expect(statSync(dir).mode & 0o077).toBe(0);
      expect(defaultCheckPrivate(dir)).toBe(true);
      expect(defaultCheckPrivate(join(dir, "missing"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
