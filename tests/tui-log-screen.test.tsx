import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { LogScreen } from "../src/tui/log-screen";
import { getThemeColors } from "../src/tui/theme";

const colors = getThemeColors("dark");

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o input");
}

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

test("LogScreen com buffer vazio avisa; esc e ctrl+c fecham (#514)", async () => {
  let closed = 0;
  const instance = render(
    <LogScreen colors={colors} header="ASTRO v1.2.3 · p/m1 · endpoint -" lines={[]} onClose={() => { closed++; }} />,
  );
  try {
    expect(instance.lastFrame() ?? "").toContain("log vazio");
    instance.stdin.write("\u001b");
    await waitFor(() => closed === 1);
    instance.stdin.write("\u0003");
    await waitFor(() => closed === 2);
  } finally {
    instance.unmount();
  }
});
