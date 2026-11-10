import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCheckPrivate, windowsAclIsPrivate } from "../src/attachments/acl";

/** SID do usuário que roda o teste (fixture, independente da máquina). */
const USER = "S-1-5-21-4106146630-3323356226-4044041718-1001";
const OTHER_USER = "S-1-5-21-4106146630-3323356226-4044041718-1002";
const GROUP = "S-1-5-21-4106146630-3323356226-4044041718-513";

/** SDDL com dono explícito e grupo qualquer (o grupo não concede acesso). */
const sddl = (owner: string, ...aces: string[]) => `O:${owner}G:${GROUP}D:PAI${aces.join("")}`;
const allow = (sid: string) => `(A;OICI;FA;;;${sid})`;

/** `(Get-Acl C:\Users\Public).Sddl` num Windows pt-BR: dono SY, mas IU/SU recebem allow. */
const PUBLIC_SDDL =
  "O:SYG:SYD:PAI(A;OICIIO;FA;;;CO)(A;;0x1200af;;;S-1-5-3)(A;OICIIO;0x1301ff;;;S-1-5-3)(A;OICIIO;0x1301ff;;;IU)(A;;0x1200af;;;IU)(A;OICIIO;0x1301ff;;;SU)(A;;0x1200af;;;SU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

describe("windowsAclIsPrivate", () => {
  test("recusa allow para qualquer trustee fora de dono/SY/BA", () => {
    const trustees = [
      "GU", "S-1-5-32-546",
      "AN", "S-1-5-7",
      "DU", "S-1-5-21-4106146630-3323356226-4044041718-513",
      "IU", "S-1-5-4",
      "WD", "S-1-1-0",
      "BU", "S-1-5-32-545",
      "AU", "S-1-5-11",
      OTHER_USER,
      "S-1-5-21-999-888-777-666",
    ];
    for (const trustee of trustees) {
      expect(windowsAclIsPrivate(sddl(USER, allow("SY"), allow(trustee)), USER)).toBe(false);
    }
  });

  test("recusa dono fora do usuário atual/SY/BA", () => {
    expect(windowsAclIsPrivate(sddl(OTHER_USER, allow("SY"), allow(USER)), USER)).toBe(false);
    expect(windowsAclIsPrivate(sddl(GROUP, allow("SY"), allow(USER)), USER)).toBe(false);
    expect(windowsAclIsPrivate(sddl("", allow("SY"), allow(USER)), USER)).toBe(false);
  });

  test("aceita dono SYSTEM ou Administrators com trustees permitidos", () => {
    expect(windowsAclIsPrivate(sddl("SY", allow("SY"), allow("BA"), allow(USER)), USER)).toBe(true);
    expect(windowsAclIsPrivate(sddl("BA", allow("SY"), allow("BA"), allow(USER)), USER)).toBe(true);
    expect(windowsAclIsPrivate(sddl("S-1-5-18", allow("S-1-5-32-544"), allow(USER)), USER)).toBe(true);
  });

  test("aceita a forma endurecida do icacls", () => {
    expect(
      windowsAclIsPrivate(
        `O:${USER}G:${GROUP}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`,
        USER,
      ),
    ).toBe(true);
  });

  test("trata alias, SID e dono case-insensitive", () => {
    expect(
      windowsAclIsPrivate(
        `O:syG:${GROUP}D:PAI(a;oici;fa;;;sy)(a;oici;fa;;;ba)(a;oici;fa;;;${USER.toLowerCase()})`,
        USER,
      ),
    ).toBe(true);
  });

  test("aceita deny e exige ao menos um allow", () => {
    expect(windowsAclIsPrivate(sddl(USER, "(D;;FR;;;WD)", allow("SY"), allow(USER)), USER)).toBe(true);
    expect(windowsAclIsPrivate(sddl(USER, "(D;;FR;;;WD)"), USER)).toBe(false);
  });

  test("recusa ACE condicional, com 7 campos ou com 5 campos", () => {
    expect(windowsAclIsPrivate(sddl(USER, "(XA;;FA;;;SY)", allow(USER)), USER)).toBe(false);
    expect(windowsAclIsPrivate(sddl(USER, "(A;OICI;FA;;;SY;X)", allow(USER)), USER)).toBe(false);
    expect(windowsAclIsPrivate(sddl(USER, "(A;OICI;FA;;SY)"), USER)).toBe(false);
  });

  test("entrada vazia, sem dono, sem ACE, lixo ou SID vazio falha fechado", () => {
    expect(windowsAclIsPrivate("", USER)).toBe(false);
    expect(windowsAclIsPrivate("O:SYG:SYD:PAI", USER)).toBe(false);
    expect(windowsAclIsPrivate(`G:${GROUP}D:PAI${allow("SY")}`, USER)).toBe(false);
    expect(windowsAclIsPrivate("garbage", USER)).toBe(false);
    expect(windowsAclIsPrivate(sddl(USER, "(A;OICI;FA;;;)"), USER)).toBe(false);
  });

  test("fixture real de C:\\Users\\Public é recusada", () => {
    expect(windowsAclIsPrivate(PUBLIC_SDDL, USER)).toBe(false);
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
