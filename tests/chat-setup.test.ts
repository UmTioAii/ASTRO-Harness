/** Setup wizard (#611): one config layer per run, never silent, never without a TTY. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as setup from "../src/chat/setup";

// RED: the module does not exist yet — the structural cast keeps the typecheck
// clean and the tests fail at runtime (`runSetup === undefined`).
type IO = { read(prompt: string): Promise<string | null>; write(text: string): void };
type Outcome = { flow: string; globalCreated: boolean; projectCreated: boolean; preset?: string; notice?: string };
type Opts = { env?: NodeJS.ProcessEnv; allowMissing?: boolean; acceptDefaults?: boolean; io?: IO };
const api = setup as unknown as {
  runSetup?: (configPath: string, opts?: Opts) => Promise<Outcome>;
  SETUP_UNATTENDED_NOTICE?: string;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const run = (configPath: string, opts: Opts = {}) => api.runSetup!(configPath, opts);

const GLOBAL_WITH_PROVIDER = JSON.stringify({
  providers: { p: { kind: "openai-compat", baseUrl: "https://p.example/v1", credentialRef: "KEY" } },
  models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
  activeProfileId: "p",
});

function fakeIO(answers: string[]) {
  const out: string[] = [];
  let index = 0;
  return {
    out,
    io: { read: async () => answers[index++] ?? null, write: (text: string) => { out.push(text); } },
  };
}

describe("setup wizard — one layer per run (#611)", () => {
  test("no TTY: asks nothing, writes nothing, one warning line and in-memory defaults", async () => {
    const cwd = tempDir("astro-setup-notty-");
    const home = tempDir("astro-setup-notty-home-");
    const outcome = await run(join(cwd, "astro.config.json"), { env: { ASTRO_HOME: home }, allowMissing: true });
    expect(outcome).toMatchObject({ flow: "unattended", preset: "default", notice: api.SETUP_UNATTENDED_NOTICE });
    expect(outcome.notice!.includes("\n")).toBe(false); // exactly one line
    expect(existsSync(join(cwd, "astro.config.json")) || existsSync(join(home, "config.json"))).toBe(false);
  });

  test("no global and no project: full wizard writes both layers, key stays out (I-03)", async () => {
    const cwd = tempDir("astro-setup-full-");
    const home = tempDir("astro-setup-full-home-");
    const configPath = join(cwd, "astro.config.json");
    const secret = "sk-sentinel-do-not-store";
    const { io } = fakeIO(["", "custom", "Local", "https://local.example/v1", "LOCAL_API_KEY", "m1", "", ""]);

    const outcome = await run(configPath, { env: { ASTRO_HOME: home, LOCAL_API_KEY: secret }, allowMissing: true, io });

    expect(outcome).toMatchObject({ flow: "full", globalCreated: true, projectCreated: true, preset: "default" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ preset: "default", agent: { model: "local/m1" } });
    const global = readFileSync(join(home, "config.json"), "utf8");
    expect(JSON.parse(global).providers.local.credentialRef).toBe("LOCAL_API_KEY");
    expect(global.includes(secret)).toBe(false); // the key never reaches a layer (I-03)
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600); // HARD_BLOCK file
  });

  test("global only: mini-setup writes the project layer and leaves the global byte for byte", async () => {
    const cwd = tempDir("astro-setup-project-");
    const home = tempDir("astro-setup-project-home-");
    writeFileSync(join(home, "config.json"), GLOBAL_WITH_PROVIDER);
    const before = readFileSync(join(home, "config.json"), "utf8");

    const outcome = await run(join(cwd, "astro.config.json"), {
      env: { ASTRO_HOME: home }, allowMissing: true, io: fakeIO(["control"]).io,
    });

    expect(outcome).toMatchObject({ flow: "project", globalCreated: false, projectCreated: true, preset: "control" });
    expect(JSON.parse(readFileSync(join(cwd, "astro.config.json"), "utf8")))
      .toEqual({ preset: "control", agent: { model: "p/m1" } });
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before); // global layer untouched
  });

  test("existing, explicit and no-global configs are skipped and never written", async () => {
    const cwd = tempDir("astro-setup-skip-");
    const home = tempDir("astro-setup-skip-home-");
    const configPath = join(cwd, "astro.config.json");
    writeFileSync(configPath, '{"agent":{"maxSteps":7}}');
    const { io, out } = fakeIO(["control", "y"]);

    const existing = await run(configPath, { env: { ASTRO_HOME: home }, allowMissing: true, io });
    expect(existing.flow).toBe("skip");
    expect(readFileSync(configPath, "utf8")).toBe('{"agent":{"maxSteps":7}}');
    expect(out).toEqual([]); // nothing was asked

    const fresh = tempDir("astro-setup-explicit-");
    const explicit = await run(join(fresh, "custom.json"), { env: { ASTRO_HOME: home }, allowMissing: false, io });
    const noGlobal = await run(join(fresh, "astro.config.json"), {
      env: { ASTRO_HOME: home, ASTRO_NO_GLOBAL_CONFIG: "1" }, allowMissing: true, io,
    });
    expect([explicit.flow, noGlobal.flow]).toEqual(["skip", "skip"]);
    expect(existsSync(join(fresh, "custom.json")) || existsSync(join(fresh, "astro.config.json"))).toBe(false);
  });

  test("provider from the environment: short flow, says which one, and can switch", async () => {
    const cwd = tempDir("astro-setup-short-");
    const home = tempDir("astro-setup-short-home-");
    const env = { ASTRO_HOME: home, OPENAI_API_KEY: "sk-env", OPENAI_MODEL: "gpt-5" };

    const kept = await run(join(cwd, "astro.config.json"), { env, allowMissing: true, io: fakeIO(["n", ""]).io });
    expect(kept).toMatchObject({ flow: "short", globalCreated: false, projectCreated: false, preset: "default" });
    expect(kept.notice).toContain("$OPENAI_API_KEY"); // always says which set it chose
    expect(existsSync(join(cwd, "astro.config.json")) || existsSync(join(home, "config.json"))).toBe(false);

    const switched = join(tempDir("astro-setup-switch-"), "astro.config.json");
    const outcome = await run(switched, { env, allowMissing: true, io: fakeIO(["y", "", "nvidia", "", "", "", "", "", ""]).io });
    expect(outcome.flow).toBe("full");
    expect(JSON.parse(readFileSync(switched, "utf8")).agent.model).toBe("nvidia/meta/llama-3.3-70b-instruct");
  });

  test("--yes takes the defaults without asking and cannot invent a provider", async () => {
    const cwd = tempDir("astro-setup-yes-");
    const home = tempDir("astro-setup-yes-home-");
    const { io, out } = fakeIO([]);

    const short = await run(join(cwd, "astro.config.json"), {
      env: { ASTRO_HOME: home, OPENAI_API_KEY: "sk-env", OPENAI_MODEL: "gpt-5" }, allowMissing: true, acceptDefaults: true, io,
    });
    expect(short).toMatchObject({ flow: "short", preset: "default" });
    expect(out).toEqual([]); // no question was printed
    expect(short.notice).toContain("using openai");

    const empty = tempDir("astro-setup-yes-empty-");
    const bare = await run(join(empty, "astro.config.json"), { env: { ASTRO_HOME: empty }, allowMissing: true, acceptDefaults: true });
    expect(bare).toMatchObject({ globalCreated: false, projectCreated: false });
    expect(bare.notice).toContain("provider");
    expect(existsSync(join(empty, "astro.config.json"))).toBe(false);
  });

  test("astro setup without a TTY prints one warning and exits 0", async () => {
    const cwd = tempDir("astro-setup-cli-");
    const home = tempDir("astro-setup-cli-home-");
    const proc = Bun.spawn(["bun", join(root, "src", "cli.ts"), "setup", "--yes"], {
      cwd, env: { ...process.env, ASTRO_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain("no interactive terminal");
    expect(existsSync(join(cwd, "astro.config.json")) || existsSync(join(home, "config.json"))).toBe(false);
  });
});
