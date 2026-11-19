import { expect, spyOn, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TUI_RENDER_OPTIONS, runTui } from "../src/tui/run";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("tui desliga o ctrl+c do Ink para a app decidir a saída", () => {
  expect(TUI_RENDER_OPTIONS.exitOnCtrlC).toBe(false);
});

test("tui recusa stdin em pipe sem carregar a interface", async () => {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    const exit = await runTui({ configPath: join(root, "astro.config.json"), cwd: root, allowMissingConfig: true });
    expect(exit).toBe(1);
  } finally {
    spy.mockRestore();
  }
  expect(lines.join("\n")).toContain("terminal interativo");
});

test("só flags chegam à TUI: sem TTY o erro é do terminal, não do argv (#543)", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "--config", "astro.config.json", "--cwd", root], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.end();
  expect(await proc.exited).toBe(1);
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toContain("terminal interativo");
  expect(stderr).not.toContain("opção desconhecida");
  expect(stderr).not.toContain("nenhum argumento");
});

test("argv vazio em pipe imprime o help e sai 0 (#543)", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts"], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toContain("Uso:");
});

test("`astro tui` deixou de existir: o comando padrão é `astro`", async () => {
  const proc = Bun.spawn(["bun", "src/cli.ts", "tui", "--cwd", root], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.end();
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('comando desconhecido: "tui"');
});

test("--artifact-root aceita caminho e rejeita valor vazio (#392)", async () => {
  const accepted = Bun.spawn(
    ["bun", "src/cli.ts", "chat", "--cwd", root, "--artifact-root", join(root, "..", "artifacts")],
    { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ASTRO_HOME: join(root, ".astro-test-home") } },
  );
  accepted.stdin.end();
  await accepted.exited;
  const stderr = await new Response(accepted.stderr).text();
  expect(stderr).not.toContain("opção desconhecida");
  expect(stderr).not.toContain("falta o valor de --artifact-root");

  const empty = Bun.spawn(
    ["bun", "src/cli.ts", "chat", "--artifact-root", "", "--cwd", root],
    { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  empty.stdin.end();
  expect(await empty.exited).toBe(1);
  expect(await new Response(empty.stderr).text()).toContain("falta o valor de --artifact-root");
});
