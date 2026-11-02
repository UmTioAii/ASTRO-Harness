import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { SessionPicker } from "../src/tui/session-picker";
import type { SessionSummary } from "../src/chat/store";

const colors = { accent: "cyan", warning: "yellow", error: "red" };

const summary = (id: string, name?: string): SessionSummary => ({
  path: `/tmp/${id}.json`, id, startedAt: "2026-10-01T10:00:00.000Z", model: "p/m1", turns: 2, costUsd: 0.001,
  ...(name === undefined ? {} : { name }),
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout esperando o frame");
}

const frame = (instance: ReturnType<typeof render>): string => instance.lastFrame() ?? "";

test("lista, navega e retoma com enter (#64)", async () => {
  const resumed: string[] = [];
  const instance = render(
    <SessionPicker
      sessions={[summary("a"), summary("b", "feature")]}
      colors={colors}
      onClose={() => {}}
      onResume={(chosen) => resumed.push(chosen.id)}
      onRename={() => undefined}
    />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    expect(frame(instance)).toContain("feature (b)");
    instance.stdin.write("\u001b[B"); // down
    await waitFor(() => frame(instance).includes("> 2."));
    instance.stdin.write("\r");
    expect(resumed).toEqual(["b"]);
  } finally {
    instance.unmount();
  }
});

test("r inicia rename a partir de vazio; enter salva; erro do callback aparece (#64)", async () => {
  const calls: Array<[string, string]> = [];
  let fail = false;
  const instance = render(
    <SessionPicker
      sessions={[summary("a", "antigo")]}
      colors={colors}
      onClose={() => {}}
      onResume={() => {}}
      onRename={(id, name) => {
        calls.push([id, name]);
        return fail ? "erro: nome inválido" : undefined;
      }}
    />,
  );
  try {
    await waitFor(() => frame(instance).includes("Sessões"));
    instance.stdin.write("r");
    await waitFor(() => frame(instance).includes("nome: _"));
    instance.stdin.write("novo");
    instance.stdin.write("\r");
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual(["a", "novo"]);
    await waitFor(() => frame(instance).includes("nome: _") === false);
    fail = true;
    instance.stdin.write("r");
    await waitFor(() => frame(instance).includes("nome: _"));
    instance.stdin.write("x");
    instance.stdin.write("\r");
    await waitFor(() => frame(instance).includes("erro: nome inválido"));
  } finally {
    instance.unmount();
  }
});

test("esc cancela o rename e close só no modo lista; lista vazia avisa (#64)", async () => {
  let closed = 0;
  const instance = render(
    <SessionPicker sessions={[]} colors={colors} onClose={() => { closed++; }} onResume={() => {}} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(instance).includes("nenhuma sessão salva"));
    instance.stdin.write("\u001b");
    await waitFor(() => closed === 1);
  } finally {
    instance.unmount();
  }

  const withSession = render(
    <SessionPicker sessions={[summary("a")]} colors={colors} onClose={() => { closed++; }} onResume={() => {}} onRename={() => undefined} />,
  );
  try {
    await waitFor(() => frame(withSession).includes("Sessões"));
    withSession.stdin.write("r");
    await waitFor(() => frame(withSession).includes("nome: _"));
    withSession.stdin.write("\u001b"); // cancela o rename, não fecha
    await waitFor(() => frame(withSession).includes("nome: _") === false);
    expect(closed).toBe(1);
  } finally {
    withSession.unmount();
  }
});
