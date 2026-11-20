import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunArgs,
  isMainEntry,
  MissingBunError,
  resolveBun,
  type ResolveDeps,
} from "../src/launcher";

const fakeResolve = (paths: Record<string, string>) => (id: string): string => {
  const value = paths[id];
  if (value === undefined) throw new Error(`not found: ${id}`);
  return value;
};

describe("resolveBun", () => {
  const base: ResolveDeps = { runningUnderBun: false, platform: "win32", arch: "x64" };

  test("ASTRO_BUN_PATH vence tudo", () => {
    const bun = join("C:", "tools", "bun.exe");
    expect(resolveBun({ ...base, env: { ASTRO_BUN_PATH: bun }, exists: () => true })).toBe(bun);
  });

  test("ASTRO_BUN_PATH inexistente falha com mensagem acionável", () => {
    expect(() => resolveBun({
      ...base,
      env: { ASTRO_BUN_PATH: join("C:", "nope", "bun.exe") },
      exists: () => false,
    })).toThrow(/ASTRO_BUN_PATH/);
  });

  test("rodando sob Bun usa o próprio executável", () => {
    const execPath = join("C:", "bun", "bun.exe");
    expect(resolveBun({ ...base, runningUnderBun: true, execPath, env: {} })).toBe(execPath);
  });

  test("usa o binário do pacote npm \"bun\"", () => {
    const manifestPath = join("C:", "app", "node_modules", "bun", "package.json");
    const bin = join("C:", "app", "node_modules", "bun", "bin", "bun.exe");
    const deps: ResolveDeps = {
      ...base,
      env: {},
      resolve: fakeResolve({ "bun/package.json": manifestPath }),
      exists: (path: string) => path === bin,
      which: () => undefined,
    };
    expect(resolveBun(deps)).toBe(bin);
  });

  test("cai para o binário do PATH", () => {
    const bun = join("C:", "tools", "bun.exe");
    expect(resolveBun({
      ...base,
      env: {},
      resolve: fakeResolve({}),
      exists: () => false,
      which: () => bun,
    })).toBe(bun);
  });

  test("sem runtime, explica como resolver", () => {
    let error: unknown;
    try {
      resolveBun({
        ...base,
        env: {},
        resolve: fakeResolve({}),
        exists: () => false,
        which: () => undefined,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MissingBunError);
    expect((error as Error).message).toContain("Bun");
    expect((error as Error).message).toContain("ASTRO_BUN_PATH");
    expect((error as Error).message).toContain("npm install");
  });
});

describe("resolveBun — pacote npm com postinstall bloqueado (npm allow-scripts, #561)", () => {
  const base: ResolveDeps = { runningUnderBun: false, platform: "win32", arch: "x64" };
  const realBin = { size: 100_000_000 };
  const placeholder = { size: 450 }; // bin/bun.exe do pacote "bun" antes do postinstall

  test("prefere o binário real do pacote de plataforma @oven/bun-* (não precisa de postinstall)", () => {
    const ovenManifest = join("C:", "app", "node_modules", "@oven", "bun-windows-x64", "package.json");
    const ovenBin = join("C:", "app", "node_modules", "@oven", "bun-windows-x64", "bin", "bun.exe");
    const bunManifest = join("C:", "app", "node_modules", "bun", "package.json");
    const bunBin = join("C:", "app", "node_modules", "bun", "bin", "bun.exe");
    // RED: `stat` ainda não existe em ResolveDeps; cast estrutural mantém o typecheck limpo.
    const deps = {
      ...base,
      env: {},
      resolve: fakeResolve({
        "@oven/bun-windows-x64/package.json": ovenManifest,
        "bun/package.json": bunManifest,
      }),
      exists: (path: string) => path === ovenBin || path === bunBin,
      stat: (path: string) => (path === ovenBin ? realBin : placeholder),
      which: () => undefined,
    } as unknown as ResolveDeps;
    // RED: hoje devolve o placeholder bun/bin/bun.exe e o spawn quebra com UV_UNKNOWN
    expect(resolveBun(deps)).toBe(ovenBin);
  });

  test("placeholder do pacote bun é ignorado e cai para o PATH", () => {
    const bunManifest = join("C:", "app", "node_modules", "bun", "package.json");
    const bunBin = join("C:", "app", "node_modules", "bun", "bin", "bun.exe");
    const onPath = join("C:", "tools", "bun.exe");
    const deps = {
      ...base,
      env: {},
      resolve: fakeResolve({ "bun/package.json": bunManifest }),
      exists: (path: string) => path === bunBin,
      stat: () => placeholder,
      which: () => onPath,
    } as unknown as ResolveDeps;
    expect(resolveBun(deps)).toBe(onPath); // RED: hoje devolve o placeholder
  });

  test("binário real do pacote bun (postinstall rodou) continua válido", () => {
    const bunManifest = join("C:", "app", "node_modules", "bun", "package.json");
    const bunBin = join("C:", "app", "node_modules", "bun", "bin", "bun.exe");
    const deps = {
      ...base,
      env: {},
      resolve: fakeResolve({ "bun/package.json": bunManifest }),
      exists: (path: string) => path === bunBin,
      stat: () => realBin,
      which: () => undefined,
    } as unknown as ResolveDeps;
    expect(resolveBun(deps)).toBe(bunBin);
  });
});

test("bunArgs monta cli + argumentos do usuário", () => {
  expect(bunArgs("dist/cli.js", ["run", "oi"])).toEqual(["dist/cli.js", "run", "oi"]);
  expect(bunArgs("dist/cli.js", [])).toEqual(["dist/cli.js"]);
});

test("reconhece o launcher executado por symlink/junction (npm POSIX)", () => {
  const dir = mkdtempSync(join(tmpdir(), "astro-launcher-link-"));
  const real = join(dir, "real");
  mkdirSync(real);
  const target = join(real, "launcher.js");
  writeFileSync(target, "// launcher", "utf8");
  const link = join(dir, "link");
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  expect(isMainEntry(join(link, "launcher.js"), target)).toBe(true);
  expect(isMainEntry(target, target)).toBe(true);
  expect(isMainEntry(join(dir, "outro.js"), target)).toBe(false);
  expect(isMainEntry(undefined, target)).toBe(false);
});
