import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HELP_TEXT } from "../src/chat/commands";
import { KEYBINDS } from "../src/tui/keybinds";

/** Bindings the composer screen answers to; `/help` and the layout doc must agree. */
const COMPOSER = ["ctrl+o", "ctrl+t", "ctrl+c", "ctrl+d", "tab", "shift+enter", "backspace"];
/** Approval keys shown by the composer takeover and accepted by the bridge. */
const APPROVAL = ["enter responde", "s aprova uma vez", "a aprova sempre", "r recusa", "n nega", "tab ver diff"];
/** Screens own their keys but share esc to go back. */
const SCREENS = ["esc"];

test("/help lists the composer, leader and approval bindings (#595)", () => {
  const help = HELP_TEXT;
  expect(help).toContain("Atalhos da TUI");
  for (const token of [...COMPOSER, ...APPROVAL, ...SCREENS]) expect(help).toContain(token);
  for (const key of Object.keys(KEYBINDS)) expect(help.toLowerCase()).toContain(key);
});

test("docs/tui-layout.md lists every binding that /help lists (#595)", () => {
  const doc = readFileSync(new URL("../docs/tui-layout.md", import.meta.url), "utf8").toLowerCase();
  for (const token of [...COMPOSER, ...APPROVAL, ...SCREENS, ...Object.keys(KEYBINDS)]) {
    expect(doc).toContain(token.toLowerCase());
  }
  expect(doc).toContain("ctrl+x");
});
