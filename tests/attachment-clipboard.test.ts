import { describe, expect, test } from "bun:test";
import { clipboardCommand, readClipboardText } from "../src/attachments/clipboard";

describe("clipboard", () => {
  test("comando por plataforma", () => {
    expect(clipboardCommand("win32")?.command).toBe("powershell");
    expect(clipboardCommand("darwin")).toEqual({ command: "pbpaste", args: [] });
    expect(clipboardCommand("linux")?.command === "wl-paste" || clipboardCommand("linux")?.command === "xclip").toBe(true);
  });

  test("leitura usa o runner injetado", () => {
    const calls: string[] = [];
    const text = readClipboardText("linux", (command) => {
      calls.push(command.command);
      return "colado";
    });
    expect(text).toBe("colado");
    expect(calls).toHaveLength(1);
  });

  test("sem runner disponível / saída vazia vira erro tipado", () => {
    expect(() => readClipboardText("linux", () => undefined)).toThrow(/clipboard/);
    expect(() => readClipboardText("linux", () => "")).toThrow(/clipboard/);
    expect(() => readClipboardText("aix", () => "x")).toThrow(/clipboard/);
  });
});
