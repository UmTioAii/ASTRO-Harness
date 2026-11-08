import { describe, expect, test } from "bun:test";
import { COMMAND_NAMES, HELP_TEXT, parseCommand } from "../src/chat/commands";

describe("/attach, /detach e /paste", () => {
  test("parse", () => {
    expect(parseCommand("/attach")).toEqual({ kind: "attach" });
    expect(parseCommand("/attach notas/a.txt")).toEqual({ kind: "attach", path: "notas/a.txt" });
    expect(parseCommand("/attach notas/a.txt 10:40")).toEqual({ kind: "attach", path: "notas/a.txt", range: "10:40" });
    expect(parseCommand("/attach arquivo com espaço.txt")).toEqual({ kind: "attach", path: "arquivo com espaço.txt" });
    expect(parseCommand("/paste")).toEqual({ kind: "paste" });
    expect(parseCommand("/detach")).toEqual({ kind: "detach" });
    expect(parseCommand("/detach 2")).toEqual({ kind: "detach", target: "2" });
    expect(parseCommand("/detach all")).toEqual({ kind: "detach", target: "all" });
  });

  test("entram na ajuda e na lista de comandos", () => {
    for (const name of ["attach", "paste", "detach"]) {
      expect(COMMAND_NAMES as readonly string[]).toContain(name);
      expect(HELP_TEXT).toContain(`/${name}`);
    }
  });
});
