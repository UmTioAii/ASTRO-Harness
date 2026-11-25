import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetColor, footerBase, modeColor, packageVersion } from "../src/tui/footer";
import { TuiApp } from "../src/tui/app";
import { getThemeColors } from "../src/tui/theme";
import { waitFor } from "./helpers/wait";

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

test("o modelo no footer passa pela redação (I-03, #663)", async () => {
  const secret = "sk-abcdefghijklmnop123456";
  const model = `p/${secret}`;
  const session = {
    model,
    snapshot: () => ({
      id: "s1", startedAt: "2026-11-24T12:00:00.000Z", model,
      messages: [], turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0.001,
    }),
    permissionMode: () => "ask" as const,
    providerName: () => "p",
    listModels: () => [model],
    // The composer screen only needs the session contract; no turn runs here.
    async send() { throw new Error("não usado"); },
    compact: async () => "não usado",
    clear() {},
    resume() {},
    setModel: (ref: string) => ref,
  };
  const instance = render(<TuiApp session={session as never} cwd={mkdtempSync(join(tmpdir(), "astro-tui-footer-secret-"))} />);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain(secret);
    expect(frame).toContain("p/[REDACTED]");
  } finally {
    instance.unmount();
  }
}, 15_000);
