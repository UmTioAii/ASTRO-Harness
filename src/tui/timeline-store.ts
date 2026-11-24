/** Live turn state for the TUI timeline (#635): maps events to entries, bodies under callId. No Ink, no I/O. */
import type { TurnEvent } from "../chat/turn-events";
import type { ChatMessage } from "../providers/types";
import type { TimelineEntry, TimelineState, TimelineTurn, TimelineTurnStatus, TimelineView } from "./timeline";

type ToolEntry = Extract<TimelineEntry, { kind: "tool" }>;

export class TimelineTurnStore {
  readonly id: string;
  readonly prompt: string;
  #entries: TimelineEntry[] = [];
  #results: Record<string, string> = {};
  #status: TimelineTurnStatus = "running";

  constructor(id: string, prompt: string) {
    this.id = id;
    this.prompt = prompt;
  }

  get turn(): TimelineTurn { return { id: this.id, prompt: this.prompt, entries: this.#entries, status: this.#status }; }
  get status(): TimelineTurnStatus { return this.#status; }
  get results(): Readonly<Record<string, string>> { return this.#results; }

  /** Returns true when a rendered line changed; `round.start` only orders. */
  apply(event: TurnEvent): boolean {
    switch (event.kind) {
      case "round.start":
        return false;
      case "reasoning": {
        // One block per completion; empty text never becomes a placeholder line.
        if (event.text.trim() === "") return false;
        this.#entries = [...this.#entries, { kind: "reasoning", text: event.text }];
        return true;
      }
      case "tool.start": {
        const entry: ToolEntry = {
          kind: "tool", callId: event.callId, name: event.name, arguments: event.arguments, status: "running",
        };
        // One entry per callId (ADR-0035): a repeated start replaces the same slot.
        const index = this.#entries.findIndex((item) => item.kind === "tool" && item.callId === event.callId);
        const next = index < 0 ? [...this.#entries, entry] : [...this.#entries];
        if (index >= 0) next[index] = entry;
        this.#entries = next;
        return true;
      }
      case "tool.end": {
        const index = this.#entries.findIndex((entry) => entry.kind === "tool" && entry.callId === event.callId);
        if (index < 0) return false;
        const current = this.#entries[index] as ToolEntry;
        const next = [...this.#entries];
        // Same slot, same callId: an entry changing status never reflows the lines above it.
        next[index] = {
          kind: "tool", callId: current.callId, name: current.name, arguments: current.arguments,
          status: event.isError ? "failed" : "ok", durationMs: event.durationMs,
        };
        this.#entries = next;
        return true;
      }
      case "turn.end":
        this.complete(event.status);
        return true;
    }
  }

  /** Fallback when the session ends without a `turn.end` (for example a thrown turn). */
  complete(status: TimelineTurnStatus): void {
    this.#status = status;
    if (status === "running") return;
    this.#entries = this.#entries.map((entry) =>
      entry.kind === "tool" && entry.status === "running" ? { ...entry, status: "failed" } : entry,
    );
  }

  /** Bodies are keyed by `callId` only; `tool.end.resultKey` is never a store key. */
  setResult(callId: string, body: string): void { this.#results = { ...this.#results, [callId]: body }; }
  setResultsFromMessages(messages: readonly ChatMessage[]): void {
    for (const message of messages) {
      if (message.role === "tool" && message.toolCallId !== undefined) this.setResult(message.toolCallId, message.content);
    }
  }

  view(state: TimelineState, status: TimelineView["status"], expanded?: TimelineView["expanded"]): TimelineView {
    return { state, status, turn: this.turn, results: this.#results, ...(expanded === undefined ? {} : { expanded }) };
  }
}
