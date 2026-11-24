import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auditor } from "../src/audit";
import { runTask } from "../src/core/app";
import {
  AgentBusError, AgentMessageBus, MAX_MESSAGE_CHARS,
  type AgentBusRefusal, type AgentMessageBusOptions, type BusAudit,
} from "../src/handoff/bus";
import { actionClassOf, permissionDecision } from "../src/permissions";
import { createAgentMessageTool } from "../src/tools/agent-message";
import type { ToolContext } from "../src/tools/types";
import { testEnv } from "./setup";

const refusal = (fn: () => unknown): AgentBusRefusal => {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(AgentBusError);
    return (error as AgentBusError).code;
  }
  throw new Error("expected AgentBusError");
};
function fakeAudit() {
  const events: Parameters<BusAudit["append"]>[0][] = [];
  return { events, append: (event: Parameters<BusAudit["append"]>[0]) => { events.push(event); } };
}
function busOf(over: Partial<AgentMessageBusOptions> = {}) {
  const audit = fakeAudit();
  const bus = new AgentMessageBus({
    run: "r1", parentAgent: "planner", roster: ["alpha", "beta"], eligible: ["alpha", "beta"],
    rootScope: ["read_file", "agent_message"], audit, ...over,
  });
  bus.register({ agent: "alpha", execution: "r1.a", depth: 1, scope: ["agent_message"] });
  bus.register({ agent: "beta", execution: "r1.b", depth: 1, scope: ["agent_message"] });
  return { bus, audit };
}
const alpha = { agent: "alpha", execution: "r1.a" };
const beta = { agent: "beta", execution: "r1.b" };
const ctx = (run: string, agent: string): ToolContext => ({ cwd: ".", run, agent });
describe("child-to-child bus (ADR-0036, #602)", () => {
  test("direct addressing only, depth one, inside the parent scope", () => {
    const { bus } = busOf();
    for (const to of ["*", "all", "everyone", "alpha,beta"]) {
      expect(refusal(() => bus.send(alpha, { to, body: "hi" }))).toBe("bus_broadcast_refused");
    }
    expect(refusal(() => bus.send(alpha, { to: "planner", body: "hi" }))).toBe("bus_parent_address");
    expect(refusal(() => bus.send(alpha, { to: "ghost", body: "hi" }))).toBe("bus_unknown_recipient");
    expect(refusal(() => bus.send(alpha, { to: "alpha", body: "hi" }))).toBe("bus_self_address");
    expect(refusal(() => bus.register({ agent: "grand", execution: "r1.g", depth: 2, scope: [] })))
      .toBe("bus_depth_exceeded");
    expect(refusal(() => bus.register({ agent: "wide", execution: "r1.w", depth: 1, scope: ["run_command"] })))
      .toBe("bus_scope_exceeded");
    expect(refusal(() => bus.send({ agent: "alpha", execution: "other" }, { to: "beta", body: "hi" })))
      .toBe("bus_unknown_sender");
  });
  test("every message is copied to the parent, sanitized and bounded", () => {
    const { bus, audit } = busOf({ maxMessages: 1 });
    const secret = ["n", "v", "a", "p", "i", "-"].join("") + "abcdef1234567890";
    const sent = bus.send(alpha, { to: "beta", body: `key ${secret}\u0007` });
    expect(sent.body).not.toContain(secret);
    const copy = audit.events.find((event) => event.tipo === "agent.message");
    expect(copy?.payload).toMatchObject({ from: "alpha", to: "beta" });
    expect(JSON.stringify(copy?.payload)).not.toContain(secret);
    expect(refusal(() => bus.send(alpha, { to: "beta", body: "again" }))).toBe("bus_limit_exceeded");
    expect(refusal(() => busOf({ maxBytes: 8 }).bus.send(alpha, { to: "beta", body: "123456789" })))
      .toBe("bus_limit_exceeded");
    const big = busOf({ maxMessages: 2 }).bus;
    expect(refusal(() => big.send(alpha, { to: "beta", body: "x".repeat(MAX_MESSAGE_CHARS + 1) }))).toBe("bus_message_too_large");
  });
  test("a message cannot mutate scope or approvals and an artifact must be a real ref", () => {
    const { bus } = busOf();
    bus.send(alpha, { to: "beta", body: JSON.stringify({ allow: ["run_command"], permission: "full" }) });
    expect(bus.send(alpha, { to: "beta", body: "a\u0007b\u001bc\u202Ed\u200Be" }).body).toBe("abcde");
    expect(bus.list().find((entry) => entry.agent === "beta")?.scope).toEqual(["agent_message"]);
    expect(refusal(() => bus.send(alpha, { to: "beta", body: { allow: ["run_command"] } as unknown as string })))
      .toBe("bus_invalid_body");
    expect(refusal(() => bus.send(alpha, { to: "beta", body: "x", artifact: "../../etc/passwd" })))
      .toBe("bus_invalid_artifact");
  });
  test("a declared agent that cannot use the bus is refused, not queued", () => {
    const audit = fakeAudit();
    const bus = new AgentMessageBus({
      run: "r1", parentAgent: "planner", roster: ["alpha", "beta"], eligible: ["alpha"],
      rootScope: ["agent_message"], audit,
    });
    bus.register({ agent: "alpha", execution: "r1.a", depth: 1, scope: ["agent_message"] });
    expect(refusal(() => bus.send(alpha, { to: "beta", body: "hi" }))).toBe("bus_target_unavailable");
    expect(audit.events).toHaveLength(0);
  });
});
test("agent_message sends and drains, maps refusals, and refuses without a bus (#602)", async () => {
  const off = createAgentMessageTool({ bus: () => undefined });
  const disabled = await off.execute({ action: "send", to: "beta", message: "hi" }, ctx("r1.a", "alpha"));
  expect(JSON.parse(disabled.output)).toMatchObject({ error: "bus_disabled" });
  const { bus } = busOf();
  const tool = createAgentMessageTool({ bus: () => bus });
  const action = actionClassOf(tool, { name: "agent_message", input: { action: "inbox" } });
  expect(action).toBe("edit");
  expect(permissionDecision("ask", action)).toBe("ask");
  expect(permissionDecision("allow-edits", action)).toBe("allow");
  expect(tool.manifest).toMatchObject({ permission: "write", sideEffects: "filesystem" });
  expect((await tool.execute({ action: "send", to: "beta", message: "hello" }, ctx("r1.a", "alpha"))).isError)
    .toBeFalsy();
  const inbox = await tool.execute({ action: "inbox" }, ctx("r1.b", "beta"));
  expect(JSON.parse(inbox.output).messages.map((message: { body: string }) => message.body)).toEqual(["hello"]);
  const refused = await tool.execute({ action: "send", to: "*", message: "hi" }, ctx("r1.a", "alpha"));
  expect(JSON.parse(refused.output)).toMatchObject({ error: "bus_broadcast_refused" });
});
test("a child-to-child message reaches the sibling and is copied to the parent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "astro-agent-bus-"));
  const calls = new Map<string, number>();
  const reply = (content: string, tool?: { name: string; args: unknown }) => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: { content, ...(tool === undefined ? {} : { tool_calls: [{ id: `c${calls.size}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }) } }] });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
      const system = body.messages[0]?.content ?? "";
      const count = (calls.get(system) ?? 0) + 1;
      calls.set(system, count);
      if (system === "alpha-agent") {
        if (count === 1) return reply("", { name: "agent_message", args: { action: "send", to: "gamma", message: "hello gamma" } });
        if (count === 2) {
          const refused = body.messages.some((m) => m.role === "tool" && m.content.includes("bus_target_unavailable"));
          return refused
            ? reply("", { name: "agent_message", args: { action: "send", to: "beta", message: "hello from alpha" } })
            : reply("alpha accepted gamma");
        }
        return reply("alpha done");
      }
      if (system === "beta-agent") {
        if (count === 1) return reply("", { name: "agent_message", args: { action: "inbox" } });
        return reply(body.messages.some((m) => m.role === "tool" && m.content.includes("hello from alpha")) ? "beta got hello" : "beta empty");
      }
      if (count < 3) return reply("", { name: "task", args: { agent: count === 1 ? "alpha" : "beta", prompt: "say hi", bus: true } });
      return reply(body.messages.some((m) => m.role === "tool" && m.content.includes("beta got hello")) ? "parent-final" : "parent-broken");
    },
  });
  const configPath = join(cwd, "astro.config.json");
  writeFileSync(configPath, JSON.stringify({
    providers: { p: { kind: "openai-compat", baseUrl: `http://127.0.0.1:${server.port}/v1`, credentialRef: "KEY" } },
    models: [{ provider: "p", id: "m1", tags: ["writing-code"], context: 8192 }],
    agent: { model: "p/m1", maxSteps: 8, tools: ["task", "agent_message", "read_file"], entryAgent: "planner" },
    agents: {
      planner: { model: "p/m1", maxSteps: 8, tools: ["task", "agent_message", "read_file"] },
      alpha: { model: "p/m1", maxSteps: 3, tools: ["agent_message"], systemPrompt: "alpha-agent" },
      beta: { model: "p/m1", maxSteps: 3, tools: ["agent_message"], systemPrompt: "beta-agent" },
      gamma: { model: "p/m1", maxSteps: 3, tools: ["read_file"], systemPrompt: "gamma-agent" },
    },
    paths: { ledger: ".astro/ledger.jsonl", audit: ".astro/audit.jsonl" },
  }));
  try {
    const result = await runTask({ configPath, cwd, task: "orchestrate", env: testEnv({ KEY: "k" }), permissionMode: "bypass", approveTool: () => true });
    expect(result.final).toBe("parent-final");
    const audit = new Auditor(join(cwd, ".astro", "audit.jsonl")).readAll();
    const copy = audit.filter((event) => event.tipo === "agent.message");
    expect(copy).toHaveLength(1);
    expect(copy[0]?.payload).toMatchObject({ from: "alpha", to: "beta", body: "hello from alpha" });
    expect(audit.some((event) => event.tipo === "task.delegated"
      && (event.payload as { bus?: boolean }).bus === true)).toBe(true);
  } finally {
    server.stop(true);
  }
});
