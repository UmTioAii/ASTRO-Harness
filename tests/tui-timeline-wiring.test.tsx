import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSession } from "../src/chat/repl";
import type { TurnEvent } from "../src/chat/turn-events";
import { TuiApp } from "../src/tui/app";
import { renderTimeline, renderTimelineZones } from "../src/tui/timeline";
import { TimelineTurnStore } from "../src/tui/timeline-store";
import { TimelineZones } from "../src/tui/timeline-zones";
import { waitFor } from "./helpers/wait";

const status = { model: "anthropic/claude-sonnet-4", mode: "ask", costUsd: 0.0021 };
const at = "2026-11-24T12:00:00.000Z";
const start = (callId: string, name: string, args: unknown): TurnEvent => ({
  kind: "tool.start", turnId: "t", callId, name, arguments: JSON.stringify(args), at,
});
const end = (callId: string, isError: boolean, durationMs = 120): TurnEvent => ({
  kind: "tool.end", turnId: "t", callId, isError, durationMs, resultKey: callId, at,
});
const turnEnd: TurnEvent = { kind: "turn.end", turnId: "t", status: "done", usage: { inputTokens: 1, outputTokens: 1 }, at };

test("tool entries move running to ok/failed in place and turn.end fails the rest", () => {
  const store = new TimelineTurnStore("t", "why did the ledger grow?");
  store.apply(start("c1", "read_file", { path: "src/a.ts" }));
  store.apply(start("c2", "run_command", { command: "bun test" }));
  const running = renderTimeline(store.view({ kind: "done" }, status), 120);
  expect(running.join("\n")).toContain("▸ read_file src/a.ts");
  expect(running.join("\n")).toContain("▸ command: bun test");

  const firstToolLine = running.findIndex((line) => line.includes("read_file"));
  expect(store.apply(end("c1", false))).toBe(true);
  const partial = renderTimeline(store.view({ kind: "done" }, status), 120);
  expect(partial.join("\n")).toContain("✓ read_file src/a.ts · 120ms");
  // the updated line keeps its position: content above never reflows
  expect(partial.findIndex((line) => line.includes("read_file"))).toBe(firstToolLine);

  expect(store.apply(end("c2", true))).toBe(true);
  expect(renderTimeline(store.view({ kind: "done" }, status), 120).join("\n")).toContain("✗ command: bun test · 120ms");

  const pending = new TimelineTurnStore("t2", "cancelled");
  pending.apply(start("c1", "read_file", { path: "a.ts" }));
  pending.apply({ ...turnEnd, status: "cancelled" });
  expect(pending.turn.entries[0]).toMatchObject({ kind: "tool", callId: "c1", status: "failed" });
});

test("tool bodies are stored under callId and expanded output is redacted (I-03)", () => {
  const secret = "sk-abcdefghijklmnop123456";
  const store = new TimelineTurnStore("t", "inspect");
  store.apply(start("call-1", "read_file", { path: "a.ts" }));
  store.apply(end("call-1", false));
  store.setResultsFromMessages([
    { role: "tool", content: `token=${secret}`, toolCallId: "call-1" },
    { role: "assistant", content: "ignored" },
  ]);
  expect(Object.keys(store.results)).toEqual(["call-1"]);
  const collapsed = renderTimeline(store.view({ kind: "done" }, status), 120).join("\n");
  expect(collapsed).not.toContain(secret);
  const expanded = renderTimeline(store.view({ kind: "done" }, status, { tools: true }), 120).join("\n");
  expect(expanded).toContain("token=[REDACTED]");
});

test("the four zones reconstruct renderTimeline and keep the status footer last", () => {
  const store = new TimelineTurnStore("t", "why did the ledger grow?");
  store.apply(start("c1", "read_file", { path: "src/a.ts" }));
  store.apply(end("c1", false));
  store.apply(turnEnd);
  const view = store.view({ kind: "done" }, status);
  for (const width of [120, 80, 60]) {
    const zones = renderTimelineZones(view, width);
    expect([...zones.identity, ...zones.timeline, ...zones.composer, ...zones.status]).toEqual(renderTimeline(view, width));
    expect(zones.status).toHaveLength(1);
    expect(zones.status[0]).toContain("claude-sonnet-4");
    expect(zones.composer[0]).toContain("❯");
  }
  expect(renderTimelineZones({ state: { kind: "empty" }, status }, 120).identity.length).toBeGreaterThan(0);
});

test("TimelineZones renders the renderer lines without reformatting them", () => {
  const view = {
    state: { kind: "done" as const },
    status,
    turn: {
      id: "t", prompt: "inspect", status: "done" as const,
      entries: [{ kind: "tool" as const, callId: "c1", name: "read_file", arguments: '{"path":"src/a.ts"}', status: "ok" as const }],
    },
  };
  const instance = render(<TimelineZones view={view} width={80} />);
  try {
    const expected = renderTimeline(view, 80).join("\n").replace(/ +$/gm, "").replace(/\n+$/, "");
    const actual = (instance.lastFrame() ?? "").split("\n").map((line) => line.replace(/ +$/g, "")).join("\n").replace(/\n+$/, "");
    expect(actual).toBe(expected);
  } finally {
    instance.unmount();
  }
});

test("live tool transitions come from tool.start/tool.end and redact arguments (#635, I-03)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const secret = "sk-abcdefghijklmnop123456";
  const session = {
    model: "p/m1",
    async send(
      _prompt: string,
      _signal?: AbortSignal,
      _onToken?: (text: string) => void,
      _attachments?: unknown,
      turn?: { observer?: (event: TurnEvent) => void },
    ) {
      turn?.observer?.({ kind: "round.start", turnId: "t", roundIndex: 1, at });
      turn?.observer?.(start("c1", "read_file", { path: "src/a.ts", apiKey: secret }));
      await gate;
      turn?.observer?.(end("c1", false));
      turn?.observer?.(start("c2", "run_command", { command: "bun test" }));
      turn?.observer?.(end("c2", true));
      turn?.observer?.(turnEnd);
      return {
        final: "eco:inspect", model: "p/m1", steps: 1, tokensIn: 1, tokensOut: 1, costUsd: 0.001,
        totalTokensIn: 1, totalTokensOut: 1, totalCostUsd: 0.001,
        contextTokens: 1, contextLimit: 100, contextRatio: 0.01, warning: false, trimmed: false,
      };
    },
    snapshot: () => ({
      id: "s1", startedAt: at, model: "p/m1", messages: [], turns: 0,
      tokensIn: 0, tokensOut: 0, costUsd: 0.001,
    }),
    listModels: () => ["p/m1"],
    permissionMode: () => "ask" as const,
    providerName: () => "p",
  } as unknown as ChatSession;
  const cwd = mkdtempSync(join(tmpdir(), "astro-timeline-wiring-"));
  const instance = render(<TuiApp session={session} cwd={cwd} />);
  try {
    instance.stdin.write("inspect");
    instance.stdin.write("\r");
    await waitFor(() => (instance.lastFrame() ?? "").includes("▸ read_file src/a.ts"), "running tool in the live timeline");
    expect(instance.lastFrame()).not.toContain(secret);

    release();
    await waitFor(() => (instance.lastFrame() ?? "").includes("✓ read_file src/a.ts"), "tool moved to ok");
    await waitFor(() => (instance.lastFrame() ?? "").includes("✗ command: bun test"), "isError mapped to failed");
    expect(instance.lastFrame()).not.toContain(secret);
    expect(instance.lastFrame()).toContain("eco:inspect");
  } finally {
    instance.unmount();
  }
}, 10_000);
