import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileLockError } from "../src/file-lock";
import { loadVault, Vault, type VaultBackend } from "../src/vault";

const plainBackend: VaultBackend = { scheme: "plain", protect: (s) => s, unprotect: (s) => s };

function tmpVault() {
  const dir = mkdtempSync(join(tmpdir(), "astro-vault-lock-"));
  return { dir, path: join(dir, "vault.json") };
}

describe("vault write lock (#605, I-03)", () => {
  test("a live lock makes create fail closed instead of losing the update", () => {
    const { path } = tmpVault();
    const v = new Vault(path, plainBackend);
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, String(process.pid), "utf8");
    try {
      let error: unknown;
      try {
        v.create({ providerId: "p", label: "l", secret: "value" });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(FileLockError);
      expect(existsSync(path)).toBe(false); // nothing written without the lock
    } finally {
      rmSync(lockPath, { force: true });
    }
  }, { timeout: 10_000 });

  test("two processes creating at the same time keep both credentials", async () => {
    const { dir, path } = tmpVault();
    const ready = (name: string) => join(dir, `${name}.ready`);
    const go = join(dir, "go");
    const vaultUrl = pathToFileURL(join(import.meta.dir, "..", "src", "vault.ts")).href;

    const childCode = (provider: string) => `
import { existsSync, writeFileSync } from "node:fs";
const { Vault } = await import(${JSON.stringify(vaultUrl)});
const path = ${JSON.stringify(path)};
const ready = ${JSON.stringify(ready(provider))};
const go = ${JSON.stringify(go)};
writeFileSync(ready, "1");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(go)) Atomics.wait(sleeper, 0, 0, 5);
new Vault(path, { scheme: "plain", protect: (s) => s, unprotect: (s) => s })
  .create({ providerId: ${JSON.stringify(provider)}, label: ${JSON.stringify(provider)}, secret: "value-${provider}" });
`;

    const children = ["p1", "p2"].map((provider) => Bun.spawn({
      cmd: [process.execPath, "-e", childCode(provider)],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    }));
    try {
      while (!existsSync(ready("p1")) || !existsSync(ready("p2"))) await Bun.sleep(5);
      writeFileSync(go, "1");
      expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    } finally {
      for (const child of children) child.kill();
    }

    const store = loadVault(path);
    expect(store.credentials.map((c) => c.providerId).sort()).toEqual(["p1", "p2"]);
  }, { timeout: 20_000 });
});
