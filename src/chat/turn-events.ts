/** Live turn events (#600): a causal, sanitized stream; the observer never changes the outcome. */
import { sanitizeBlockText, sanitizePromptText } from "../sanitize-external";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

export type TurnStatus = "done" | "failed" | "cancelled";

export type TurnEvent =
  | { kind: "round.start"; turnId: string; roundIndex: number; at: string }
  | { kind: "reasoning"; turnId: string; text: string; at: string }
  | { kind: "tool.start"; turnId: string; callId: string; name: string; arguments: string; at: string }
  | { kind: "tool.end"; turnId: string; callId: string; isError: boolean; durationMs: number; resultKey: string; at: string }
  | { kind: "turn.end"; turnId: string; status: TurnStatus; usage: TurnUsage; at: string };

export type TurnObserver = (event: TurnEvent) => void | Promise<void>;

/** Cap of `tool.start.arguments`: an event is a signal, not a transport. */
export const MAX_TURN_ARGUMENT_CHARS = 2048;

/**
 * Cap of a reasoning block: a chain of thought is rendered, not shipped, so a
 * multi-megabyte block is cut with a marker instead of being retained whole.
 */
export const MAX_REASONING_CHARS = 16_000;

/** Sanitiza e limita os argumentos antes de qualquer observador (I-03). */
export function sanitizeTurnArguments(argumentsJson: string): string {
  const chars = Array.from(sanitizePromptText(argumentsJson));
  if (chars.length <= MAX_TURN_ARGUMENT_CHARS) return chars.join("");
  return `${chars.slice(0, MAX_TURN_ARGUMENT_CHARS - 1).join("")}…`;
}

/**
 * Reasoning is a block: the shared block pipeline redacts the whole text first
 * (a PEM spans lines), then sanitizes each line so the renderer keeps its
 * breaks and indentation (I-03). Oversized blocks are cut with a marker.
 */
export function sanitizeReasoningText(text: string): string {
  const clean = sanitizeBlockText(text);
  const chars = Array.from(clean);
  if (chars.length <= MAX_REASONING_CHARS) return clean;
  return `${chars.slice(0, MAX_REASONING_CHARS - 1).join("")}…`;
}

/** Consome a rejeição de um observador async: o turno nunca depende dele (I-19). */
function settle(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => {});
  }
}

export interface TurnEventStreamOptions {
  turnId: string;
  observer?: TurnObserver;
  /** Injectable clock for duration and timestamps in tests. */
  now?: () => number;
}

type PendingEnd = { isError: boolean; resultKey: string; durationMs?: number };

/** Orders one turn causally; `turn.end` fails every entry still running. */
export class TurnEventStream {
  readonly #turnId: string;
  readonly #observer: TurnObserver | undefined;
  readonly #now: () => number;
  #open = new Map<string, number>();
  #earlyEnds = new Map<string, PendingEnd>();
  #closed = false;

  constructor(opts: TurnEventStreamOptions) {
    this.#turnId = opts.turnId;
    this.#observer = opts.observer;
    this.#now = opts.now ?? Date.now;
  }

  roundStart(roundIndex: number): void {
    if (this.#closed || this.#observer === undefined) return;
    this.#deliver({ kind: "round.start", turnId: this.#turnId, roundIndex, at: this.#at() });
  }

  /** One sanitized block per provider completion; an absent or empty text emits nothing. */
  reasoning(text: string): void {
    if (this.#closed || this.#observer === undefined) return;
    const clean = sanitizeReasoningText(text);
    if (clean.trim() === "") return;
    this.#deliver({ kind: "reasoning", turnId: this.#turnId, text: clean, at: this.#at() });
  }

  toolStart(callId: string, name: string, argumentsJson: string): void {
    if (this.#closed || this.#observer === undefined) return;
    this.#open.set(callId, this.#now());
    this.#deliver({
      kind: "tool.start", turnId: this.#turnId, callId,
      name, arguments: sanitizeTurnArguments(argumentsJson), at: this.#at(),
    });
    const early = this.#earlyEnds.get(callId);
    if (early === undefined) return;
    this.#earlyEnds.delete(callId);
    this.#finish(callId, early);
  }

  toolEnd(callId: string, isError: boolean, resultKey: string, durationMs?: number): void {
    if (this.#closed || this.#observer === undefined) return;
    const end: PendingEnd = { isError, resultKey, ...(durationMs === undefined ? {} : { durationMs }) };
    if (!this.#open.has(callId)) {
      this.#earlyEnds.set(callId, end);
      return;
    }
    this.#finish(callId, end);
  }

  turnEnd(status: TurnStatus, usage: TurnUsage): void {
    if (this.#closed || this.#observer === undefined) return;
    for (const callId of [...this.#open.keys()]) this.#finish(callId, { isError: true, resultKey: "" });
    // An end whose start never arrived has no line to fail; drop the buffer.
    this.#earlyEnds.clear();
    this.#deliver({ kind: "turn.end", turnId: this.#turnId, status, usage, at: this.#at() });
    this.#closed = true;
  }

  #finish(callId: string, end: PendingEnd): void {
    const startedAt = this.#open.get(callId);
    this.#open.delete(callId);
    if (startedAt === undefined) return;
    this.#deliver({
      kind: "tool.end", turnId: this.#turnId, callId, isError: end.isError,
      durationMs: end.durationMs ?? Math.max(0, this.#now() - startedAt),
      resultKey: end.resultKey, at: this.#at(),
    });
  }

  #deliver(event: TurnEvent): void {
    if (this.#observer === undefined) return;
    try {
      settle(this.#observer(event));
    } catch {
      // An observer error never changes the turn outcome (#600).
    }
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }
}
