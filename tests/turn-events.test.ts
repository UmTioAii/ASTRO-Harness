import { describe, expect, test } from "bun:test";
import { TurnEventStream, type TurnEvent } from "../src/chat/turn-events";

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
