import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, sessionSummaryLine } from "../src/chat/store";

const store = (): SessionStore => new SessionStore(mkdtempSync(join(tmpdir(), "astro-session-name-")));

const snapshot = (id: string) => ({
  id,
  startedAt: "2026-10-01T10:00:00.000Z",
  model: "p/m1",
  messages: [{ role: "user" as const, content: "velho" }],
  turns: 1,
  tokensIn: 10,
  tokensOut: 5,
  costUsd: 0.001,
});

describe("rename de sessão (#64)", () => {
  test("grava o nome no mesmo arquivo e a lista/linha passam a mostrá-lo", () => {
    const sessions = store();
    const path = sessions.write(snapshot("abc"));
    const renamed = sessions.rename("abc", "  refatoração do parser  ");
    expect(renamed.name).toBe("refatoração do parser");
    expect(renamed.path).toBe(path); // mesmo arquivo, sem duplicar
    const listed = sessions.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("refatoração do parser");
    expect(sessionSummaryLine(listed[0]!, 0)).toContain("refatoração do parser");
    expect(sessions.load("abc").record.name).toBe("refatoração do parser");
  });

  test("nome vazio, longo demais ou com caractere de controle é recusado sem tocar no arquivo", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    expect(() => sessions.rename("abc", "   ")).toThrow(/nome da sessão inválido/);
    expect(() => sessions.rename("abc", "x".repeat(61))).toThrow(/nome da sessão inválido/);
    expect(() => sessions.rename("abc", "a\u0000b")).toThrow(/nome da sessão inválido/);
    expect(sessions.load("abc").record.name).toBeUndefined();
    expect(sessions.list()[0]!.name).toBeUndefined();
    expect(() => sessions.rename("nope", "x")).toThrow(/não encontrada/);
  });

  test("persistir a sessão de novo depois do rename preserva o nome", () => {
    const sessions = store();
    const snap = snapshot("abc");
    sessions.write(snap);
    sessions.rename("abc", "parser");
    sessions.write(snap); // auto-save do turno ou persist(false) no exit reescreve o mesmo arquivo
    expect(sessions.list()[0]!.name).toBe("parser");
  });

  test("nome inválido no disco não derruba a sessão: vira ausente na leitura", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    const path = sessions.list()[0]!.path;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.name = "a\tb";
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]!.name).toBeUndefined();
    expect(sessions.load("abc").record.name).toBeUndefined();
  });

  test("o limite de nome conta code points (emoji não é recusado)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    expect(sessions.rename("abc", "😀".repeat(31)).name).toBe("😀".repeat(31));
    expect(() => sessions.rename("abc", "😀".repeat(61))).toThrow(/nome da sessão inválido/);
  });

  test("nome que cresce na redação não corrompe a sessão (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    // 54 chars passam no limite, mas a redação expande acima de 60: falha limpa, sem sumir da lista
    expect(() => sessions.rename("abc", "password=a password=b password=c password=d password=e"))
      .toThrow(/nome da sessão inválido/);
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]!.name).toBeUndefined();
    // nome curto com segredo: grava e devolve o valor redigido, e continua listável
    const renamed = sessions.rename("abc", "login password=abc");
    expect(renamed.name).toBe("login password=[REDACTED]");
    expect(sessions.list()[0]!.name).toBe("login password=[REDACTED]");
  });

  test("nome com bidi, zero-width ou C1 é recusado (#64)", () => {
    const sessions = store();
    sessions.write(snapshot("abc"));
    for (const bad of ["a\u202eb", "a\u200bb", "a\u009fb", "a\ufeffb"]) {
      expect(() => sessions.rename("abc", bad)).toThrow(/nome da sessão inválido/);
    }
    expect(sessions.list()).toHaveLength(1);
  });
});
