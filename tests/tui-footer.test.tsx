import { expect, test } from "bun:test";
import { budgetColor, footerBase, modeColor, packageVersion } from "../src/tui/footer";
import { getThemeColors } from "../src/tui/theme";

const colors = getThemeColors("dark");

test("packageVersion lê a versão semântica do package.json (#274)", () => {
  expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
});

test("footerBase só mostra campos com valor (#480)", () => {
  expect(footerBase({ place: "~", tokensIn: 0, tokensOut: 0, costUsd: null })).toBe("~");
  // #594: the conversation carries no turn counter; tokens and cost stay.
  expect(footerBase({ place: "~", tokensIn: 10, tokensOut: 5, costUsd: 0.5 }))
    .toBe("~ · 10/5 tokens · US$ 0.500000");
  expect(footerBase({ place: "~", tokensIn: 1, tokensOut: 0, costUsd: null }))
    .toBe("~ · 1/0 tokens");
});

test("modeColor: só bypass usa cor de alerta (#270)", () => {
  expect(modeColor("bypass", colors)).toBe(colors.error);
  expect(modeColor("allow-edits", colors)).toBeUndefined();
  expect(modeColor("ask", colors)).toBeUndefined();
  expect(modeColor(undefined, colors)).toBeUndefined();
});

test("budgetColor: teto em erro, aviso em warning, resto sem cor (#480)", () => {
  expect(budgetColor({ warning: false, exhausted: false, ceilingHit: true }, colors)).toBe(colors.error);
  expect(budgetColor({ warning: false, exhausted: true, ceilingHit: false }, colors)).toBe(colors.error);
  expect(budgetColor({ warning: true, exhausted: false, ceilingHit: false }, colors)).toBe(colors.warning);
  expect(budgetColor({ warning: false, exhausted: false, ceilingHit: false }, colors)).toBeUndefined();
});
