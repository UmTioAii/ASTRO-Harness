import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAgentLock } from "../src/agent-lock";
import { Auditor } from "../src/audit";
import { runTask } from "../src/core/app";
import { Ledger } from "../src/ledger";
import { assertResumeIdentity, rebuildAgentTree, ReplayIncompleteError } from "../src/resume";
import { testEnv } from "./setup";

function setup(provider = "a", credentialRef: string | null = "KEY_A", seedProvider = provider, seedCredential: string | null = credentialRef) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-resume-identity-"));
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string };
      seen.push(body.model ?? "");
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  const config = {
    providers: {
      a: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, ...(credentialRef === null ? {} : { credentialRef }) },
      b: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY_B" },
    },
    models: [
      { provider: "a", id: "m1", tags: ["writing-code"], context: 8192 },
      { provider: "b", id: "m1", tags: ["writing-code"], context: 8192 },
    ],
    agent: { model: `${provider}/m1`, maxSteps: 1, tools: [] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  };
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify(config));
  mkdirSync(join(cwd, ".astro"), { recursive: true });
  const ledger = new Ledger(join(cwd, ".astro", "ledger.jsonl"));
  ledger.recordAgentCreated({
    run: "r1",
    agent_id: "default",
    session_id: "r1",
    model: "m1",
    provider: seedProvider,
    ...(seedCredential === null ? {} : { credentialRef: seedCredential }),
  });
  ledger.recordState("r1", "interrupted", { agent: "default", reason: "cancelled" });
  return { cwd, configPath, seen, server, ledger };
}

describe("identidade efetiva no resume (I-08, #163)", () => {
  test("troca de provider mantendo o id recusa sem chamar o provider novo", async () => {
    const { cwd, configPath, seen, server } = setup("b", "KEY_B", "a", "KEY_A");
    try {
      await expect(runTask({
        configPath, task: "continue", cwd, env: testEnv({ KEY_A: "1", KEY_B: "2" }), resume: "r1",
      })).rejects.toBeInstanceOf(ReplayIncompleteError);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("troca de credentialRef no mesmo provider recusa", async () => {
    const { cwd, configPath, seen, server } = setup("a", "KEY_B", "a", "KEY_A");
    try {
      await expect(runTask({
        configPath, task: "continue", cwd, env: testEnv({ KEY_B: "2" }), resume: "r1",
      })).rejects.toThrow(/credencial do agente/);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("keyed para keyless recusa", async () => {
    const { cwd, configPath, seen, server, ledger } = setup("a", null, "a", "KEY_A");
    try {
      expect(rebuildAgentTree(ledger, "r1").active?.credentialRef).toBe("KEY_A");
      await expect(runTask({
        configPath, task: "continue", cwd, env: testEnv({ KEY_A: "1" }), resume: "r1",
      })).rejects.toThrow(/credencial do agente/);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("keyless para keyed recusa", async () => {
    const { cwd, configPath, seen, server } = setup("a", "KEY_A", "a", null);
    try {
      await expect(runTask({
        configPath, task: "continue", cwd, env: testEnv({ KEY_A: "1" }), resume: "r1",
      })).rejects.toThrow(/credencial do agente/);
      expect(seen).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("ledger antigo sem provider usa o cap resolvido na retomada", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-resume-cap-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"));
    const audit = new Auditor(join(dir, "audit.jsonl"));
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "planner", session_id: "r1", provider: "a", credentialRef: "KEY_A",
    });
    const node = { agent_id: "planner", session_id: "r1" };
    for (const [run, agent] of [["o1", "one"], ["o2", "two"]] as const) {
      acquireAgentLock(ledger, audit, {
        run, agent_id: agent, session_id: run, provider: "b", credentialRef: "KEY_B",
      });
    }
    // cap 4: two holders on KEY_B still leave room.
    assertResumeIdentity(node, { provider: "b", credentialRef: "KEY_B" }, ledger, "r1", 4);
    expect(ledger.readAllEntries().some((entry) => entry.kind === "agent"
      && entry.event === "identity" && entry.credentialRef === "KEY_B")).toBe(true);
  });

  test("cap 1 recusa a retomada antes de gravar identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "astro-resume-cap1-"));
    const ledger = new Ledger(join(dir, "ledger.jsonl"));
    const audit = new Auditor(join(dir, "audit.jsonl"));
    acquireAgentLock(ledger, audit, {
      run: "r1", agent_id: "planner", session_id: "r1", provider: "a", credentialRef: "KEY_A",
    });
    acquireAgentLock(ledger, audit, {
      run: "o1", agent_id: "one", session_id: "o1", provider: "b", credentialRef: "KEY_B",
    });
    const node = { agent_id: "planner", session_id: "r1" };
    expect(() => assertResumeIdentity(node, { provider: "b", credentialRef: "KEY_B" }, ledger, "r1", 1))
      .toThrow(/execuções/);
    expect(ledger.readAllEntries().some((entry) => entry.kind === "agent"
      && entry.event === "identity" && entry.credentialRef === "KEY_B")).toBe(false);
  });

  test("ledger antigo sem provider é aceito uma vez e grava a identidade", async () => {
    const { cwd, configPath, seen, server, ledger } = setup("a", "KEY_A");
    try {
      // remove os campos de identidade do created para simular ledger antigo
      const path = join(cwd, ".astro", "ledger.jsonl");
      const lines = (await Bun.file(path).text()).trim().split("\n");
      const cleaned = lines.map((line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.kind === "agent") {
          delete entry.provider;
          delete entry.credentialRef;
        }
        return JSON.stringify(entry);
      });
      writeFileSync(path, `${cleaned.join("\n")}\n`);
      const fresh = new Ledger(path);

      await runTask({ configPath, task: "continue", cwd, env: testEnv({ KEY_A: "1" }), resume: "r1" });
      expect(seen).toEqual(["m1"]);
      const identity = fresh.readAllEntries().find((e) => e.kind === "agent" && e.event === "identity");
      expect(identity).toMatchObject({ provider: "a", credentialRef: "KEY_A", model: "m1" });
      const node = rebuildAgentTree(fresh, "r1").nodes[0]!;
      expect(() => assertResumeIdentity(node, { provider: "b", credentialRef: "KEY_B" }, fresh, "r1"))
        .toThrow(/provider do agente/);
      const started = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll()
        .find((e) => e.tipo === "run.started");
      expect(started?.payload).toMatchObject({ provider: "a", credentialRef: "KEY_A" });
    } finally {
      server.stop(true);
    }
  });
});
