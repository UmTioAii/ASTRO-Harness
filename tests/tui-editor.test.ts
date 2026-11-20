import { describe, expect, test } from "bun:test";
import * as editor from "../src/tui/editor";
import { COMMANDS, applyCompletion, commandDescription, completionItems, suggestionWindow } from "../src/tui/editor";

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

describe("enterAction — semântica do Enter com o menu aberto (#471, #560)", () => {
  // RED: enterAction ainda não existe; cast estrutural mantém o typecheck limpo.
  const api = editor as unknown as { enterAction?: (line: string, suggestion?: string) => string };

  test("máquina de estado pura: prefixo aplica, exato roda, argumento roda", () => {
    expect(api.enterAction).toBeTypeOf("function"); // RED: ainda não existe
    const enter = api.enterAction!;
    // prefixo do comando destacado: 1º Enter aplica a completion, 2º roda
    expect(enter("/re", "/resume")).toBe("apply-completion");
    expect(enter("/mo", "/model")).toBe("apply-completion");
    // linha já igual ao destacado: 1º Enter roda direto
    expect(enter("/resume", "/resume")).toBe("run");
    // linha com argumento após o comando: Enter submete normal
    expect(enter("/model p/m1", undefined)).toBe("run");
    // sem menu aberto: run
    expect(enter("texto qualquer", undefined)).toBe("run");
    expect(enter("/re", undefined)).toBe("run");
    // completion de @arquivo está fora de escopo (#471): Enter submete
    expect(enter("leia @app", "@src/app.ts")).toBe("run");
  });

  test("prefixo nunca executa sem o 2º Enter confirmando (#471)", () => {
    const enter = api.enterAction!;
    // depois de aplicar, a linha fica exata e só então o próximo Enter roda
    const applied = applyCompletion("/re", "/resume");
    expect(enter("/re", "/resume")).toBe("apply-completion");
    expect(enter(applied, "/resume")).toBe("run");
  });
});
