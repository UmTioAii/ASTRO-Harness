/**
 * #594: turn and round limits are enforced, typed and readable.
 * A turn is one prompt through the final answer; a round is one model call plus its tools.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/chat/agent-session";
import { MaxRoundsError, MaxTurnsError } from "../src/core/session";
import type { ChatMessage } from "../src/providers/types";
import { testEnv } from "./setup";

interface Body { messages?: ChatMessage[] }

function setup(config: Record<string, unknown>, reply: (call: number) => Response) {
  const cwd = mkdtempSync(join(tmpdir(), "astro-limits-"));
  writeFileSync(join(cwd, "a.txt"), "conteudo\n");
  let call = 0;
  const server = Bun.serve({ port: 0, async fetch(req) {
    await req.json();
    call++;
    return reply(call);
  } });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 100000 }],
    agent: { model: "p/m1", tools: ["read_file"] },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
    ...config,
  }));
  return {
    cwd,
    calls: () => call,
    session: () => new AgentSession({ configPath, cwd, env: testEnv({ KEY: "k" }), systemPrompt: "sys" }),
    stop: () => server.stop(true),
  };
}

const final = (content = "done"): Response =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

const reads = (count: number, prefix: string): Response => Response.json({
  choices: [{
    message: {
      content: "",
      tool_calls: Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`, type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
      })),
    },
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

describe("#594 turn and round limits", () => {
  test("a turn with 40 tool calls across 11 rounds completes under the default limits", async () => {
    // 10 rounds of 4 calls (40 tool calls) then a final answer on round 11.
    const { cwd, session, stop } = setup({ version: "2.0.0", preset: "control" }, (call) =>
      call <= 10 ? reads(4, `c${call}`) : final());
    const chat = session();
    try {
      const result = await chat.send("leia tudo");
      expect(result.final).toBe("done");
      expect(result.rounds).toBe(11);
      expect(chat.snapshot()).toMatchObject({ turns: 1 });
      expect(join(cwd, "a.txt")).toBeString();
    } finally {
      chat.close();
      stop();
    }
  });

  test("run.maxTurns: 1 lets the first turn finish and refuses the second with a human message", async () => {
    const { session, stop } = setup({ version: "2.0.0", preset: "control", run: { maxTurns: 1 } }, () => final());
    const chat = session();
    try {
      const first = await chat.send("primeiro");
      expect(first.final).toBe("done");
      const second = chat.send("segundo");
      await expect(second).rejects.toBeInstanceOf(MaxTurnsError);
      await expect(second).rejects.toThrow(/run\.maxTurns/);
      await expect(second).rejects.toThrow(/did not converge/);
      expect(chat.snapshot().turns).toBe(1);
    } finally {
      chat.close();
      stop();
    }
  });

  test("run.maxRoundsPerTurn stops an unconverging turn with a typed error naming the setting", async () => {
    const { cwd, calls, session, stop } = setup(
      { version: "2.0.0", preset: "control", agent: { model: "p/m1", tools: ["read_file"], maxSteps: 3 },
        run: { maxRoundsPerTurn: 100, noProgressSegments: 1000 } },
      () => reads(1, "loop"),
    );
    const chat = session();
    try {
      const error = await chat.send("nunca converge").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MaxRoundsError);
      expect((error as MaxRoundsError).limit).toBe(100);
      expect((error as MaxRoundsError).rounds).toBe(100);
      expect((error as Error).message).toContain("run.maxRoundsPerTurn");
      expect(calls()).toBe(100);
      expect(join(cwd, "a.txt")).toBeString();
    } finally {
      chat.close();
      stop();
    }
  });

  test("an unlimited round limit does not stop the turn", async () => {
    const { session, stop } = setup(
      { version: "2.0.0", preset: "control", run: { maxRoundsPerTurn: "unlimited", noProgressSegments: 1000 } },
      (call) => call < 12 ? reads(1, `u${call}`) : final(),
    );
    const chat = session();
    try {
      const result = await chat.send("converge no fim");
      expect(result.final).toBe("done");
      expect(result.rounds).toBe(12);
    } finally {
      chat.close();
      stop();
    }
  });
});
