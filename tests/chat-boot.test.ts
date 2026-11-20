import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { bootChat } from "../src/chat/boot";
import { nodeReplIO } from "../src/chat/node-io";
import { loadHomeState, saveHomeState } from "../src/home-state";
import { TERMS_VERSION } from "../src/terms";

const ISO = "2026-11-20T12:00:00.000Z";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "astro-boot-"));
}

describe("boot do chat: portão dos termos antes do I/O (#479)", () => {
  test("recusa: o portão roda antes do readline do REPL e não grava config nem estado", async () => {
    const root = workdir();
    const home = join(root, "home");
    const config = join(root, "astro.config.json");
    const globalConfig = join(home, "config.json");
    const state = join(home, "state.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(config, '{"agent":{"model":"p/m"}}\n');
    writeFileSync(globalConfig, '{"providers":{}}\n');
    saveHomeState({ version: 1, trust: { folders: [root] }, migrations: { providers: true, trust: true } }, state);
    const before = [config, globalConfig, state].map((path) => readFileSync(path, "utf8"));
    let prompted = 0;

    const boot = await bootChat({
      path: state,
      ask: () => {
        prompted++;
        // A pergunta acontece com o stdin ainda sem o readline do REPL.
        expect(prompted).toBe(1);
        return false;
      },
      createIO: () => {
        throw new Error("I/O do REPL criado antes do portão dos termos");
      },
    });

    expect(boot).toEqual({ kind: "declined" });
    expect([config, globalConfig, state].map((path) => readFileSync(path, "utf8"))).toEqual(before);
    expect(existsSync(join(root, ".astro"))).toBe(false);
  });

  test("aceite: grava só o terms e preserva trust e migrations do state.json", async () => {
    const root = workdir();
    const state = join(root, "state.json");
    saveHomeState({ version: 1, trust: { folders: [root] }, migrations: { providers: true, trust: false } }, state);

    const boot = await bootChat({
      path: state,
      ask: () => true,
      now: () => new Date(ISO),
      createIO: () => nodeReplIO(new PassThrough(), new PassThrough()),
    });
    if (boot.kind !== "ready") throw new Error(`esperava ready, veio ${boot.kind}`);
    boot.io.close();

    const saved = loadHomeState(state);
    expect(saved.terms).toEqual({ version: TERMS_VERSION, acceptedAt: ISO });
    expect(saved.trust).toEqual({ folders: [root] });
    expect(saved.migrations).toEqual({ providers: true, trust: false });
  });

  test("sem TTY: segue sem aceite e só então cria o I/O do REPL", async () => {
    const root = workdir();
    const state = join(root, "state.json");
    let created = 0;

    const boot = await bootChat({
      path: state,
      createIO: () => {
        created++;
        return nodeReplIO(new PassThrough(), new PassThrough());
      },
    });
    if (boot.kind !== "unattended") throw new Error(`esperava unattended, veio ${boot.kind}`);
    boot.io.close();

    expect(created).toBe(1);
    expect(existsSync(state)).toBe(false);
  });
});
