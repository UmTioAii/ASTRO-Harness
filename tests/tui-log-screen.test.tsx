import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LogScreen } from "../src/tui/log-screen";
import { getThemeColors } from "../src/tui/theme";

const colors = getThemeColors("dark");

test("LogScreen mostra o cabeçalho da sessão (com endpoint) e as linhas do buffer (#514)", () => {
  const instance = render(
    <LogScreen
      colors={colors}
      header="ASTRO v1.2.3 · p/m1 · endpoint https://p.example/v1"
      lines={["turno concluído · 1 step(s)", "[p/m1] 1 step(s) · 10/5 tokens"]}
      onClose={() => {}}
    />,
  );
  try {
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("log da sessão");
    expect(frame).toContain("ASTRO v1.2.3 · p/m1 · endpoint https://p.example/v1");
    expect(frame).toContain("turno concluído · 1 step(s)");
    expect(frame).toContain("[p/m1] 1 step(s) · 10/5 tokens");
  } finally {
    instance.unmount();
  }
});

test("LogScreen com buffer vazio avisa; esc e ctrl+c fecham (#514)", () => {
  let closed = 0;
  const instance = render(
    <LogScreen colors={colors} header="ASTRO v1.2.3 · p/m1 · endpoint -" lines={[]} onClose={() => { closed++; }} />,
  );
  try {
    expect(instance.lastFrame() ?? "").toContain("log vazio");
    instance.stdin.write("\u001b");
    expect(closed).toBe(1);
    instance.stdin.write("\u0003");
    expect(closed).toBe(2);
  } finally {
    instance.unmount();
  }
});
