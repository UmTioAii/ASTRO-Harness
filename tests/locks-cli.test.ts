import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger } from "../src/ledger";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "cli.ts");

const cfg = {
  providers: {
    proj: { kind: "openai-compat", baseUrl: "https://proj.example/v1", credentialRef: "SENTINEL_KEY" },
  },
  models: [{ provider: "proj", id: "p1", tags: ["writing-code"], context: 8192 }],
  agent: { model: "proj/p1", maxSteps: 2, tools: ["read_file"] },
  paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
};

interface SeedLock {
  run: string;
  agent: string;
  pid?: number;
  provider?: string;
  model?: string;
  credentialRef?: string;
}

function setup(locks: SeedLock[] = []): { dir: string; cfgPath: string; ledgerPath: string; auditPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "astro-locks-cli-"));
  mkdirSync(join(dir, ".astro"), { recursive: true });
  const cfgPath = join(dir, "astro.config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  const ledgerPath = join(dir, ".astro", "ledger.jsonl");
  const auditPath = join(dir, ".astro", "audit.jsonl");
  const ledger = new Ledger(ledgerPath);
  for (const lock of locks) {
    ledger.recordAgentCreated({
      run: lock.run,
      agent_id: lock.agent,
      session_id: lock.run,
      ...(lock.provider === undefined ? {} : { provider: lock.provider }),
      ...(lock.model === undefined ? {} : { model: lock.model }),
      ...(lock.credentialRef === undefined ? {} : { credentialRef: lock.credentialRef }),
      ...(lock.pid === undefined ? {} : { pid: lock.pid }),
    });
  }
  return { dir, cfgPath, ledgerPath, auditPath };
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn([process.execPath, entry, ...args], {
    cwd: env.ASTRO_CWD ?? root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

function cli(dir: string, cfgPath: string, args: string[]) {
  return run([...args, "--config", cfgPath], {
    ASTRO_HOME: join(dir, "home"),
    ASTRO_CWD: dir,
    // Valor de segredo semeado no ambiente: nome no ledger, nunca o valor (I-03).
    SENTINEL_KEY: "sentinel-xyz",
  });
}

describe("astro locks (#527)", () => {
  test("lista a conta presa com run, agente, conta, pid e idade", async () => {
    const { dir, cfgPath } = setup([
      { run: "run-a", agent: "default", pid: process.pid, provider: "proj", model: "p1", credentialRef: "SENTINEL_KEY" },
    ]);

    const { out, code } = await cli(dir, cfgPath, ["locks"]);

    expect(code).toBe(0);
    expect(out).toContain("run-a");
    expect(out).toContain("default");
    expect(out).toContain("SENTINEL_KEY");
    expect(out).toContain(String(process.pid));
    expect(out).toContain("vivo");
    expect(out).toContain("há ");
  });

  test("sem conta presa sai 0 com mensagem clara", async () => {
    const { dir, cfgPath } = setup();

    const { out, code } = await cli(dir, cfgPath, ["locks"]);

    expect(code).toBe(0);
    expect(out).toContain("nenhuma conta presa");
  });

  test("--json devolve array sem valor de segredo", async () => {
    const { dir, cfgPath } = setup([
      { run: "run-a", agent: "default", pid: process.pid, provider: "proj", model: "p1", credentialRef: "SENTINEL_KEY" },
    ]);

    const { out, code } = await cli(dir, cfgPath, ["locks", "--json"]);
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;

    expect(code).toBe(0);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      run: "run-a",
      agent_id: "default",
      accountRef: "SENTINEL_KEY",
      alive: true,
    });
    expect(parsed[0]!.created_at).toBeString();
    expect(parsed[0]!.ageMs).toBeNumber();
    expect(out).not.toContain("sentinel-xyz");
  });

  test("--json só vale em locks list", async () => {
    const { dir, cfgPath } = setup([
      { run: "run-a", agent: "default", pid: 999_999, credentialRef: "SENTINEL_KEY" },
    ]);

    const { err, code } = await cli(dir, cfgPath, ["locks", "release", "run-a", "--json"]);

    expect(code).not.toBe(0);
    expect(err).toContain("--json");
  });

  test("--force só vale em locks release", async () => {
    const { dir, cfgPath } = setup([
      { run: "run-a", agent: "default", pid: 999_999, credentialRef: "SENTINEL_KEY" },
    ]);

    const { err, code } = await cli(dir, cfgPath, ["locks", "--force"]);

    expect(code).not.toBe(0);
    expect(err).toContain("--force");
  });

  test("release sem --force recusa quando o pid dono está vivo", async () => {
    const { dir, cfgPath, ledgerPath } = setup([
      { run: "run-a", agent: "default", pid: process.pid, provider: "proj", model: "p1", credentialRef: "SENTINEL_KEY" },
    ]);

    const { err, code } = await cli(dir, cfgPath, ["locks", "release", "run-a"]);

    expect(code).not.toBe(0);
    expect(err).toContain("run-a");
    expect(err).toContain(String(process.pid));
    expect(err).toContain("--force");
    expect(readFileSync(ledgerPath, "utf8")).not.toContain("destroyed");
  });

  test("release --force libera a conta e audita manual_release", async () => {
    const { dir, cfgPath, ledgerPath, auditPath } = setup([
      { run: "run-a", agent: "default", pid: process.pid, provider: "proj", model: "p1", credentialRef: "SENTINEL_KEY" },
    ]);

    const { out, code } = await cli(dir, cfgPath, ["locks", "release", "run-a", "--force"]);

    expect(code).toBe(0);
    expect(out).toContain("conta liberada");
    expect(readFileSync(ledgerPath, "utf8")).toContain('"event":"destroyed"');
    expect(readFileSync(ledgerPath, "utf8")).toContain('"reason":"manual_release_forced"');
    expect(readFileSync(auditPath, "utf8")).toContain("agent.lock.released");
  });

  test("release libera sem --force quando o pid dono está morto", async () => {
    const { dir, cfgPath, ledgerPath } = setup([
      { run: "run-a", agent: "default", pid: 999_999, provider: "proj", model: "p1", credentialRef: "SENTINEL_KEY" },
    ]);

    const { out, code } = await cli(dir, cfgPath, ["locks", "release", "run-a"]);

    expect(code).toBe(0);
    expect(out).toContain("conta liberada");
    expect(readFileSync(ledgerPath, "utf8")).toContain('"event":"destroyed"');
  });

  test("release de run desconhecido sai diferente de 0 e não cria destroyed", async () => {
    const { dir, cfgPath, ledgerPath } = setup([
      { run: "run-a", agent: "default", pid: process.pid, credentialRef: "SENTINEL_KEY" },
    ]);

    const { err, code } = await cli(dir, cfgPath, ["locks", "release", "run-z"]);

    expect(code).not.toBe(0);
    expect(err).toContain("nada para liberar");
    expect(readFileSync(ledgerPath, "utf8")).not.toContain("destroyed");
  });

  test("release com duas contas no mesmo run exige --agent", async () => {
    const { dir, cfgPath } = setup([
      { run: "run-a", agent: "default", pid: process.pid, credentialRef: "SENTINEL_KEY" },
      { run: "run-a", agent: "worker", pid: process.pid, credentialRef: "OUTRA_KEY" },
    ]);

    const { err, code } = await cli(dir, cfgPath, ["locks", "release", "run-a", "--force"]);

    expect(code).not.toBe(0);
    expect(err).toContain("--agent");
    expect(existsSync(join(dir, ".astro", "ledger.jsonl"))).toBe(true);
  });
});
