import { describe, expect, test } from "bun:test";
import {
  displayWidth,
  renderTimeline,
  toolLabel,
  type TimelineState,
  type TimelineTurn,
  type TimelineView,
} from "../src/tui/timeline";
import { sanitizeBlockText } from "../src/sanitize-external";

const status = { model: "anthropic/claude-sonnet-4", mode: "ask", costUsd: 0.0021 };
const turn: TimelineTurn = {
  id: "turn-1",
  prompt: "why did the ledger grow?",
  status: "running",
  entries: [
    { kind: "reasoning", text: "Inspect the ledger schema first.", durationMs: 4000 },
    { kind: "tool", callId: "call-1", name: "read_file", arguments: '{"path":"src/ledger.ts"}', status: "ok", durationMs: 420 },
  ],
};

const STATES: ReadonlyArray<readonly [string, TimelineState]> = [
  ["empty", { kind: "empty" }], ["thinking", { kind: "thinking", elapsedMs: 12000 }],
  ["streaming", { kind: "streaming", partial: "The ledger grew because every tool call appends a record." }],
  ["approval", { kind: "approval", question: "approve run_command: bun test" }],
  ["error", { kind: "error", message: "network timeout", hint: "retry; raise providers.x.timeoutMs if it persists" }],
  ["done", { kind: "done" }],
];

/** The done state adds the answer; every other state renders the running turn above. */
function view(state: TimelineState): TimelineView {
  if (state.kind === "empty") return { state, status };
  if (state.kind !== "done") return { state, status, turn };
  const entries = [...turn.entries, { kind: "answer" as const, markdown: "**Done.** The ledger is append-only." }];
  return { state, status, turn: { ...turn, entries, status: "done" } };
}
function frame(state: TimelineState, width: number): string {
  return renderTimeline(view(state), width).join("\n");
}
/** Fenced code and an indented tool body: both must keep their relative indentation. */
const blocks: TimelineView = {
  ...view({ kind: "done" }),
  expanded: { tools: true },
  results: { "call-1": "line 1\n  indented 2\u0007" },
  turn: {
    ...turn,
    status: "done",
    entries: [
      { kind: "answer", markdown: "```ts\nfunction f() {\n  return 1;\n}\n```" },
      { kind: "tool", callId: "call-1", name: "read_file", arguments: '{"path":"src/a.ts"}', status: "ok" },
    ],
  },
};
describe("timeline (#595)", () => {
  test("every state at 120, 80 and 60 columns", () => {
    const snapshot = [120, 80, 60]
      .flatMap((width) => STATES.map(([name, state]) => `### ${name} @${width} ${JSON.stringify(renderTimeline(view(state), width))}`))
      .join("\n");
    expect(snapshot).toMatchSnapshot("timeline states");
  });

  test("no rendered line exceeds the supplied width from 40 to 200", () => {
    for (let width = 40; width <= 200; width++) {
      for (const [name, state] of STATES) {
        for (const line of frame(state, width).split("\n")) {
          expect(displayWidth(line), `${name} @${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
      for (const line of renderTimeline(blocks, width)) {
        expect(displayWidth(line), `blocks @${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  test("durations follow the width bands and width counts display columns", () => {
    expect(frame({ kind: "thinking", elapsedMs: 12000 }, 120)).toContain("12s");
    expect(frame({ kind: "thinking", elapsedMs: 12000 }, 80)).toContain("12s");
    expect(frame({ kind: "thinking", elapsedMs: 12000 }, 60)).not.toContain("12s");
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("▸")).toBe(2); // East-Asian-Ambiguous: 2 columns in a CJK terminal
  });

  test("no state renders a step, round or tool counter", () => {
    for (const width of [120, 80, 60]) {
      for (const [name, state] of STATES) {
        const text = frame(state, width);
        expect(text, `${name} @${width}`).not.toMatch(/\b(?:step|round|tool)s?\b[^\n]*\b\d+\b/i);
        expect(text, `${name} @${width}`).not.toMatch(/\b\d+\s+(?:step|round|tool)/i);
        expect(text, `${name} @${width}`).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
      }
    }
  });

  test("tool labels are derived and unknown tools fall back to the name", () => {
    expect(toolLabel("read_file", '{"path":"src/a.ts"}')).toBe("read_file src/a.ts");
    expect(toolLabel("run_command", '{"command":"bun test"}')).toBe("command: bun test");
    expect(toolLabel("edit", '{"path":"src/a.ts","diff":"@@ -1 +1,2 @@\\n-old\\n+new\\n+more"}')).toBe("edit src/a.ts (+2 −1)");
    expect(toolLabel("custom_tool", "not json")).toBe("custom_tool");
  });

  test("expanded tool output and reasoning are redacted before display (I-03)", () => {
    const secret = "sk-abcdefghijklmnop123456";
    const expanded: TimelineView = {
      state: { kind: "done" },
      status,
      expanded: { tools: true, reasoning: true },
      results: { "call-1": `token=${secret}` },
      turn: {
        ...turn,
        entries: [
          { kind: "tool", callId: "call-1", name: "read_file", arguments: '{"path":"src/a.ts"}', status: "ok" },
          { kind: "reasoning", text: `reasoning ${secret}`, durationMs: 10 },
        ],
      },
    };
    const text = renderTimeline(expanded, 120).join("\n");
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
    const streaming = renderTimeline({ state: { kind: "streaming", partial: `leak ${secret}` }, status }, 120).join("\n");
    const approval = renderTimeline({ state: { kind: "approval", question: "approve?", answerHint: secret }, status }, 120).join("\n");
    expect(streaming).not.toContain(secret);
    expect(approval).not.toContain(secret);
  });

  test("block content keeps indentation and strips controls (I-03)", () => {
    const lines = renderTimeline(blocks, 120);
    expect(JSON.stringify(lines)).toMatchSnapshot("block indentation");
    expect(lines).toContain("    return 1;");
    expect(lines).toContain("      indented 2");
    expect(lines.join("\n")).not.toContain("\u0007");
  });

  test("tab-indented blocks keep their indentation (#635)", () => {
    const tabbed: TimelineView = {
      state: { kind: "done" },
      status,
      expanded: { tools: true },
      results: { "call-1": "target:\n\tbun test" },
      turn: {
        ...turn,
        status: "done",
        entries: [
          { kind: "answer", markdown: "```make\nall:\n\tbun test\n```" },
          { kind: "tool", callId: "call-1", name: "read_file", arguments: '{"path":"Makefile"}', status: "ok" },
        ],
      },
    };
    const lines = renderTimeline(tabbed, 80);
    // Fenced answer: the tab becomes four spaces; tool body: the two-space pad plus the tab.
    expect(lines).toContain("    bun test");
    expect(lines).toContain("      bun test");
    expect(lines.join("\n")).not.toContain("\t");
  });

  test("sanitizeBlockText strips ANSI/OSC and never eats the line after an unterminated OSC (#635, I-03)", () => {
    const osc52 = "c2VjcmV0LWNsaXBib2FyZA==";
    const input = [
      "first",
      `\x1b]52;c;${osc52}\x07after`,
      "before",
      "\x1b]0;unterminated",
      "last line",
      "\x07",
      "esc \x1b[31mred\x1b[0m rlo \u202eevil",
    ].join("\n");
    const out = sanitizeBlockText(input);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\u202e");
    expect(out).not.toContain(osc52);
    expect(out).toContain("after");
    expect(out).toContain("last line");
    expect(out).toContain("red");
    expect(out).toContain("evil");
  });
});
