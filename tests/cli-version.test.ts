import { expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src", "cli.ts");

function run(args: string[]) {
  const proc = Bun.spawn(["bun", cli, ...args], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.end();
  return proc;
}

test("--version, -v e version imprimem a versão do package.json", async () => {
  const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version: string };
  for (const args of [["--version"], ["-v"], ["version"]]) {
    const proc = run(args);
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out.trim()).toBe(`astro ${pkg.version}`);
  }
});

test("help imprime o help e sai 0, como --help", async () => {
  const proc = run(["help"]);
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out).toContain("Uso:");
  expect(out).toContain("astro run");
});

test("flags sem comando abrem a TUI em vez de 'comando desconhecido'", async () => {
  const proc = run(["--config", "nao-existe.json"]);
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(err).not.toContain("comando desconhecido");
  expect(err).toContain("terminal interativo");
});
