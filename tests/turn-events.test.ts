import { describe, expect, test } from "bun:test";
import { MAX_TURN_ARGUMENT_CHARS, TurnEventStream, type TurnEvent } from "../src/chat/turn-events";

// Built at runtime so the gate never sees a PEM literal in the diff (same rule as sanitize-external).
const PEM_BEGIN = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
const PEM_END = ["-----END ", "RSA PRIVATE KEY", "-----"].join("");
const PEM_BODY = ["MIIEowIBAAKCAQEA", "fakebody"].join("");

/** Stream with an injectable clock; the observer records every delivered event. */
function collect() {
  let now = 1_000;
  const events: TurnEvent[] = [];
  const stream = new TurnEventStream({
    turnId: "turn-1",
    now: () => now,
    observer: (event) => { events.push(event); },
  });
  return { advance: (ms: number) => { now += ms; }, events, stream };
}

const kinds = (events: readonly TurnEvent[]): string[] => events.map((event) => event.kind);

describe("TurnEventStream (#600)", () => {
  test("delivers round, live tool and turn events in causal order with a sanitized payload", () => {
    const { advance, events, stream } = collect();
    stream.roundStart(1);
    advance(250);
    stream.toolStart("c1", "write_file", JSON.stringify({
      path: "a.txt", apiKey: "sk-abcdefgh12345678",
    }));
    advance(40);
    stream.toolEnd("c1", false, "c1");
    stream.turnEnd("done", { inputTokens: 10, outputTokens: 5 });

    expect(kinds(events)).toEqual(["round.start", "tool.start", "tool.end", "turn.end"]);
    expect(events[0]).toEqual({ kind: "round.start", turnId: "turn-1", roundIndex: 1, at: new Date(1_000).toISOString() });
    const start = events[1]!;
    if (start.kind !== "tool.start") throw new Error("expected tool.start");
    expect(start).toMatchObject({ turnId: "turn-1", callId: "c1", name: "write_file" });
    expect(start.arguments).not.toContain("sk-abcdefgh12345678");
    expect(start.arguments).toContain("[REDACTED]");
    expect(events[2]).toMatchObject({ callId: "c1", isError: false, durationMs: 40, resultKey: "c1" });
    expect(events[3]).toMatchObject({ status: "done", usage: { inputTokens: 10, outputTokens: 5 } });
  });

  test("buffers a tool.end until its tool.start arrives", () => {
    const { events, stream } = collect();
    stream.roundStart(1);
    stream.toolEnd("c1", true, "c1", 12);
    expect(kinds(events)).toEqual(["round.start"]);
    stream.toolStart("c1", "read_file", "{}");
    expect(kinds(events)).toEqual(["round.start", "tool.start", "tool.end"]);
    expect(events[2]).toMatchObject({ isError: true, durationMs: 12 });
  });

  test("strips control characters and bounds oversized arguments", () => {
    const { events, stream } = collect();
    stream.roundStart(1);
    const long = "y".repeat(MAX_TURN_ARGUMENT_CHARS * 2);
    stream.toolStart("c1", "write_file", `{"path":"a.txt","content":"x\u001b]52;c;ZGF0YQ==\u0007${long}"}`);
    const start = events[1]!;
    if (start.kind !== "tool.start") throw new Error("expected tool.start");
    expect(start.arguments).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(start.arguments.length).toBeLessThanOrEqual(MAX_TURN_ARGUMENT_CHARS);
  });

  test("delivers one sanitized reasoning event with no result payload (I-03)", () => {
    const { events, stream } = collect();
    stream.roundStart(1);
    stream.reasoning("plano com chave sk-abcdefgh12345678\nsegunda linha com \u001b[31mcor");

    expect(kinds(events)).toEqual(["round.start", "reasoning"]);
    const event = events[1]!;
    if (event.kind !== "reasoning") throw new Error("expected reasoning");
    expect(event.turnId).toBe("turn-1");
    expect(event.text).not.toContain("sk-abcdefgh12345678");
    expect(event.text).toContain("[REDACTED]");
    // A block keeps its line breaks; only invisible controls die.
    expect(event.text).toContain("\nsegunda linha");
    expect(event.text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    expect("resultKey" in event).toBe(false);
    expect("usage" in event).toBe(false);
  });

  test("redacts a multi-line PEM and leaves no CSI residue (I-03)", () => {
    const { events, stream } = collect();
    stream.reasoning(`plano\n${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}\ncor \u001b[31mvermelha`);

    const event = events[0]!;
    if (event.kind !== "reasoning") throw new Error("expected reasoning");
    expect(event.text).not.toContain(PEM_BODY);
    expect(event.text).toContain("[REDACTED]");
    // ESC dies but its CSI body would survive per-line scrubbing: the block pipeline strips both.
    expect(event.text).not.toContain("[31m");
    expect(event.text).toContain("cor vermelha");
  });

  test("caps an oversized reasoning block with a truncation marker (I-03)", () => {
    const { events, stream } = collect();
    stream.reasoning("x".repeat(100_000));

    const event = events[0]!;
    if (event.kind !== "reasoning") throw new Error("expected reasoning");
    expect(Array.from(event.text).length).toBeLessThanOrEqual(16_000);
    expect(event.text.endsWith("…")).toBe(true);
  });

  test("emits no reasoning event for an empty text or after the turn ended", () => {
    const { events, stream } = collect();
    stream.reasoning("");
    stream.reasoning("   \n  ");
    expect(events).toEqual([]);
    stream.reasoning("plano");
    stream.turnEnd("done", { inputTokens: 0, outputTokens: 0 });
    stream.reasoning("tarde demais");
    expect(kinds(events)).toEqual(["reasoning", "turn.end"]);
  });

  test("marks every running tool as failed when the turn is cancelled", () => {
    const { advance, events, stream } = collect();
    stream.roundStart(1);
    advance(30);
    stream.toolStart("c1", "run_command", "{}");
    advance(20);
    stream.turnEnd("cancelled", { inputTokens: 0, outputTokens: 0 });

    expect(kinds(events)).toEqual(["round.start", "tool.start", "tool.end", "turn.end"]);
    expect(events[2]).toMatchObject({ callId: "c1", isError: true, durationMs: 20, resultKey: "" });
    expect(events[3]).toMatchObject({ status: "cancelled" });
  });
});
