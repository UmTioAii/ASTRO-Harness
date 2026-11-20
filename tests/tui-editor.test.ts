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

describe("enter com o menu de comandos (S5 revisado, #471)", () => {
  test("prefixo completa a linha e não roda", () => {
    expect(enterAction("/mo", ["/model"], 0)).toEqual({ action: "complete", line: "/model" });
    expect(enterAction("/cl", ["/clear"], 0)).toEqual({ action: "complete", line: "/clear" });
    expect(enterAction("/", COMMANDS.map((command) => command.name), 0))
      .toEqual({ action: "complete", line: "/help" });
  });

  test("completa o item destacado, não o primeiro da lista", () => {
    const suggestions = ["/session", "/sessions", "/save"];
    expect(enterAction("/s", suggestions, 2)).toEqual({ action: "complete", line: "/save" });
    // seleção fora da faixa (frame antigo) clampa como a UI (#276)
    expect(enterAction("/s", suggestions, 9)).toEqual({ action: "complete", line: "/save" });
  });

  test("linha exatamente igual ao comando destacado roda no primeiro enter", () => {
    expect(enterAction("/clear", ["/clear"], 0)).toEqual({ action: "run", line: "/clear" });
    expect(enterAction("/session", ["/session", "/sessions"], 0)).toEqual({ action: "run", line: "/session" });
    expect(enterAction("/sessions", ["/session", "/sessions"], 1)).toEqual({ action: "run", line: "/sessions" });
  });

  test("argumento depois do comando, texto normal e @arquivo seguem o envio normal", () => {
    expect(enterAction("/model gpt-x", [], 0)).toEqual({ action: "run", line: "/model gpt-x" });
    expect(enterAction("/model gpt-x", ["/model"], 0)).toEqual({ action: "run", line: "/model gpt-x" });
    expect(enterAction("texto livre", [], 0)).toEqual({ action: "run", line: "texto livre" });
    expect(enterAction("", [], 0)).toEqual({ action: "run", line: "" });
    expect(enterAction("leia @app", ["@src/app.ts"], 0)).toEqual({ action: "run", line: "leia @app" });
  });

  test("linha multi-linha nunca completa nem roda o comando destacado", () => {
    expect(enterAction("/cl\nx", [], 0)).toEqual({ action: "run", line: "/cl\nx" });
    // mesmo com o menu aberto num frame anterior, multi-linha é prompt
    expect(enterAction("/clear\npergunta", ["/clear"], 0)).toEqual({ action: "run", line: "/clear\npergunta" });
  });

  test("nenhum prefixo de comando roda sem o segundo enter", () => {
    for (const command of COMMANDS) {
      for (let length = 1; length < command.name.length; length++) {
        const prefix = command.name.slice(0, length);
        const suggestions = completionItems(prefix);
        const index = suggestions.indexOf(command.name);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(enterAction(prefix, suggestions, index)).toEqual({ action: "complete", line: command.name });
      }
    }
  });
});
