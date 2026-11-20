import { describe, expect, test } from "bun:test";
import { COMMANDS, applyCompletion, commandDescription, completionItems, enterAction, suggestionWindow } from "../src/tui/editor";

const files = ["src/app.ts", "notas/ideias.md"];

describe("completions do editor (T2, #63)", () => {
  test("/ completa comandos e para no primeiro espaço", () => {
    expect(completionItems("/mo", COMMANDS, files)).toContain("/model");
    expect(completionItems("/ne")).toEqual(["/new"]);
    expect(completionItems("/res")).toEqual(["/resume"]);
    expect(completionItems("/model p/m1", COMMANDS, files)).toEqual([]);
    expect(completionItems("texto", COMMANDS, files)).toEqual([]);
    expect(completionItems("daniel@exemplo.com", COMMANDS, files)).toEqual([]);
  });

  test("@ completa arquivos e preserva o texto anterior", () => {
    expect(completionItems("leia @app", COMMANDS, files)).toEqual(["@src/app.ts"]);
    expect(completionItems("leia @nmd", COMMANDS, files)).toEqual(["@notas/ideias.md"]);
    expect(completionItems("leia @notas/", COMMANDS, files)).toEqual(["@notas/ideias.md"]);
  });

  test("/log entra na completion de comandos com descrição (#514)", () => {
    expect(completionItems("/lo")).toEqual(["/log"]);
    expect(commandDescription("/log")).toContain("log");
  });

  test("applyCompletion substitui comando e insere arquivo com espaço", () => {
    expect(applyCompletion("/mo", "/model")).toBe("/model");
    expect(applyCompletion("leia @app", "@src/app.ts")).toBe("leia @src/app.ts ");
  });

  test("/ lista todos os comandos sem corte fixo e cada um tem descrição (#276)", () => {
    const all = completionItems("/", COMMANDS, files);
    expect(all.length).toBe(COMMANDS.length);
    expect(all.length).toBeGreaterThan(6);
    expect(all).toContain("/model");
    for (const command of COMMANDS) {
      expect(command.name.startsWith("/")).toBe(true);
      expect(command.description.length).toBeGreaterThan(0);
    }
    expect(commandDescription("/model")).toContain("modelo");
    expect(commandDescription("/sessions")).toContain("exclui");
    // `/terms` é anunciado pelo /help; a sugestão da TUI não pode omiti-lo (#591).
    expect(COMMANDS.map((command) => command.name)).toContain("/terms");
    expect(commandDescription("/terms")).toContain("termos");
  });

  test("suggestionWindow rola mantendo o selecionado visível (#276)", () => {
    const total = COMMANDS.length;
    expect(suggestionWindow(total, 0, 8)).toEqual({ start: 0, end: 8 });
    expect(suggestionWindow(total, 4, 8)).toEqual({ start: 0, end: 8 });
    expect(suggestionWindow(total, 10, 8)).toEqual({ start: 6, end: 14 });
    expect(suggestionWindow(total, total - 1, 8)).toEqual({ start: total - 8, end: total });
    expect(suggestionWindow(5, 2, 8)).toEqual({ start: 0, end: 5 });
  });
});

describe("enterAction — semântica do Enter com o menu aberto (#471, #560)", () => {
  test("máquina de estado pura: prefixo aplica, exato roda, argumento roda", () => {
    // prefixo do comando destacado: 1º Enter aplica a completion, 2º roda
    expect(enterAction("/re", "/resume")).toBe("apply-completion");
    expect(enterAction("/mo", "/model")).toBe("apply-completion");
    // linha já igual ao destacado: 1º Enter roda direto
    expect(enterAction("/resume", "/resume")).toBe("run");
    // linha com argumento após o comando: Enter submete normal
    expect(enterAction("/model p/m1", undefined)).toBe("run");
    // sem menu aberto: run
    expect(enterAction("texto qualquer", undefined)).toBe("run");
    expect(enterAction("/re", undefined)).toBe("run");
    // completion de @arquivo está fora de escopo (#471): Enter submete
    expect(enterAction("leia @app", "@src/app.ts")).toBe("run");
  });

  test("prefixo nunca executa sem o 2º Enter confirmando (#471)", () => {
    // depois de aplicar, a linha fica exata e só então o próximo Enter roda
    const applied = applyCompletion("/re", "/resume");
    expect(enterAction("/re", "/resume")).toBe("apply-completion");
    expect(enterAction(applied, "/resume")).toBe("run");
  });
});
