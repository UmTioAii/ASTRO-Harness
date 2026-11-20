import { describe, expect, test } from "bun:test";
import * as logModule from "../src/tui/log";
import { LOG_CAP, appendLog, sessionHeaderLine, tailLog } from "../src/tui/log";

describe("buffer de log da sessão em memória (#514, docs/tui-layout.md §/log)", () => {
  test("appendLog anexa e, acima do teto, descarta as linhas mais antigas", () => {
    let lines: string[] = [];
    for (let i = 0; i < LOG_CAP + 5; i++) lines = appendLog(lines, `linha ${i}`);
    expect(lines.length).toBe(LOG_CAP);
    expect(lines[0]).toBe("linha 5");
    expect(lines[lines.length - 1]).toBe(`linha ${LOG_CAP + 4}`);
  });

  test("appendLog é puro: não altera o array anterior", () => {
    const base = ["a"];
    const next = appendLog(base, "b");
    expect(base).toEqual(["a"]);
    expect(next).toEqual(["a", "b"]);
  });

  test("appendLog redacta segredo e remove controle/OSC antes de guardar (I-03)", () => {
    const [line] = appendLog([], "falha na chamada token=abcdef123456\u001b[31m");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("abcdef123456");
    expect(line).not.toContain("\u001b");
  });

  test("segredo com caractere de controle embutido também é redigido: redact roda no texto sem controle (I-03)", () => {
    const [line] = appendLog([], "chave sk-\u001babcdef1234 fim");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("abcdef1234");
    expect(line).not.toContain("\u001b");
  });

  test("log usa a mesma regra canônica do prompt: C1, bidi, ZWSP e surrogate solto fora (#536)", () => {
    const [line] = appendLog([], "ok\u009b2J \u202Egnp.exe a\u200Bb \ud800");
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
    expect(line).toContain("gnp.exe");
  });

  test("tailLog: sem n devolve tudo; com n devolve as últimas n; n fora de 1..∞ devolve vazio", () => {
    const lines = ["1", "2", "3", "4"];
    expect(tailLog(lines)).toEqual(lines);
    expect(tailLog(lines, 2)).toEqual(["3", "4"]);
    expect(tailLog(lines, 99)).toEqual(lines);
    expect(tailLog(lines, 0)).toEqual([]);
    expect(tailLog(lines, -1)).toEqual([]);
    expect(tailLog(lines, 1.5)).toEqual([]);
  });

  test("sessionHeaderLine: cabeçalho da sessão no /log leva versão, provider/modelo e endpoint", () => {
    expect(sessionHeaderLine({ version: "1.2.3", model: "p/m1", endpoint: "https://p.example/v1" }))
      .toBe("ASTRO v1.2.3 · p/m1 · endpoint https://p.example/v1");
  });
});

describe("laneLine — prefixo de lane para o /log mostrar lanes separadas (#560)", () => {
  // RED: laneLine ainda não existe; cast estrutural mantém o typecheck limpo.
  const api = logModule as unknown as { laneLine?: (lane: string, line: string) => string };

  test("prefixa a linha com [lane] e a sanitização continua no appendLog", () => {
    expect(api.laneLine).toBeTypeOf("function"); // RED: ainda não existe
    expect(api.laneLine!("turno", "turno concluído · 1 step(s)")).toBe("[turno] turno concluído · 1 step(s)");
    expect(api.laneLine!("sessão", "ASTRO v1.0.0 · p/m1")).toBe("[sessão] ASTRO v1.0.0 · p/m1");
    const [line] = appendLog([], api.laneLine!("aviso", "custo alto token=abcdef123456"));
    expect(line).toContain("[aviso]");
    expect(line).toContain("[REDACTED]"); // I-03: a lane não enfraquece a redação
    expect(line).not.toContain("abcdef123456");
  });
});
