import { expect, test } from "bun:test";
import { defaultArgs, isInteractive, routeArgv } from "../src/cli-default";

test("sem argumentos em terminal interativo abre a TUI sem injetar comando", () => {
  expect(defaultArgs([], true)).toEqual([]);
});

test("sem argumentos em pipe imprime o help", () => {
  expect(defaultArgs([], false)).toEqual(["--help"]);
});

test("argumentos explícitos passam intactos", () => {
  expect(defaultArgs(["run", "oi"], true)).toEqual(["run", "oi"]);
  expect(defaultArgs(["run", "oi"], false)).toEqual(["run", "oi"]);
  expect(defaultArgs(["--help"], true)).toEqual(["--help"]);
  expect(defaultArgs(["--config", "x"], false)).toEqual(["--config", "x"]);
});

test("só é interativo com stdin e stdout em TTY", () => {
  expect(isInteractive(true, true)).toBe(true);
  expect(isInteractive(true, false)).toBe(false);
  expect(isInteractive(false, true)).toBe(false);
  expect(isInteractive(undefined, true)).toBe(false);
  expect(isInteractive(true, undefined)).toBe(false);
});

test("meio-TTY não abre a TUI", () => {
  expect(defaultArgs([], isInteractive(true, false))).toEqual(["--help"]);
  expect(defaultArgs([], isInteractive(false, true))).toEqual(["--help"]);
});

test("argv vazio roteia para a TUI (#543)", () => {
  expect(routeArgv([])).toEqual({ kind: "tui", options: [] });
});

test("só flags roteiam para a TUI com as mesmas opções (#543)", () => {
  expect(routeArgv(["--config", "x.json"])).toEqual({ kind: "tui", options: ["--config", "x.json"] });
  expect(routeArgv(["--no-global-config"])).toEqual({ kind: "tui", options: ["--no-global-config"] });
});

test("help e versão são comandos, não flags (#543)", () => {
  expect(routeArgv(["help"])).toEqual({ kind: "help" });
  expect(routeArgv(["--version"])).toEqual({ kind: "version" });
  expect(routeArgv(["-v"])).toEqual({ kind: "version" });
  expect(routeArgv(["version"])).toEqual({ kind: "version" });
  expect(routeArgv(["--help"])).toEqual({ kind: "help" });
  expect(routeArgv(["run", "--help"])).toEqual({ kind: "help" });
});

test("comando explícito mantém os argumentos intactos (#543)", () => {
  expect(routeArgv(["run", "oi"])).toEqual({ kind: "command", command: "run", rest: ["oi"] });
  expect(routeArgv(["tui"])).toEqual({ kind: "command", command: "tui", rest: [] });
});
