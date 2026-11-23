/**
 * Pure timeline renderer (#595): maps conversation state to terminal lines.
 * No Ink import, no TTY, no I/O; the Ink zones only compose these strings.
 * Contract: docs/adr/0035-tui-timeline.md.
 */
import { sanitizePromptText } from "../sanitize-external";

export type TimelineToolStatus = "running" | "ok" | "failed";
export type TimelineTurnStatus = "running" | "done" | "failed" | "cancelled";

export type TimelineEntry =
  | { kind: "reasoning"; text: string; durationMs: number }
  | { kind: "tool"; callId: string; name: string; arguments: string; status: TimelineToolStatus; durationMs?: number }
  | { kind: "answer"; markdown: string }
  | { kind: "error"; message: string; hint?: string }
  | { kind: "notice"; message: string };

export interface TimelineTurn {
  readonly id: string;
  readonly prompt: string;
  readonly entries: readonly TimelineEntry[];
  readonly status: TimelineTurnStatus;
}

export type TimelineState =
  | { readonly kind: "empty" }
  | { readonly kind: "thinking"; readonly elapsedMs: number }
  | { readonly kind: "streaming"; readonly partial: string }
  | { readonly kind: "approval"; readonly question: string; readonly answerHint?: string }
  | { readonly kind: "error"; readonly message: string; readonly hint?: string }
  | { readonly kind: "done" };

export interface TimelineView {
  readonly state: TimelineState;
  readonly turn?: TimelineTurn;
  readonly status: { model: string; mode: string; costUsd?: number | null };
  /** ctrl+o expands tool output, ctrl+t expands reasoning; both collapsed by default. */
  readonly expanded?: { tools?: boolean; reasoning?: boolean };
  /** Tool bodies by `callId`, fetched by `resultKey`; read only when expanded. */
  readonly results?: Readonly<Record<string, string>>;
}

export const COMPOSER_PROMPT = "❯";

export interface TimelineLayout {
  readonly contentWidth: number;
  readonly indent: string;
  readonly durations: boolean;
  readonly fullModel: boolean;
  readonly blockLogo: boolean;
}

/** Width bands from the TUIX spec: 120+, 80–119, 60–79, below 60. */
export function timelineLayout(width: number): TimelineLayout {
  const w = Math.max(1, Math.floor(width));
  if (w >= 120) {
    return { contentWidth: Math.min(100, w - 2), indent: "  ", durations: true, fullModel: true, blockLogo: true };
  }
  if (w >= 80) return { contentWidth: w, indent: "", durations: true, fullModel: true, blockLogo: true };
  if (w >= 60) return { contentWidth: w - 2, indent: "  ", durations: false, fullModel: false, blockLogo: true };
  return { contentWidth: w, indent: "", durations: false, fullModel: false, blockLogo: false };
}

/** East Asian wide and emoji ranges occupy two columns; combining marks stay at one. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}]/u;

/** Display columns of a line, so clipping and the property test agree. */
export function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) total += WIDE.test(char) ? 2 : 1;
  return total;
}

/** Clips to `max` display columns, keeping the source order and ending in `…`. */
export function clipLine(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const step = WIDE.test(char) ? 2 : 1;
    if (used + step > max - 1) break;
    out += char;
    used += step;
  }
  return `${out}…`;
}

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** One-line field: invisible marks and secrets removed (I-03), whitespace collapsed. */
function inline(text: string): string {
  return sanitizePromptText(text).replace(/\s+/g, " ").trim();
}

/** Block field: drops ANSI/CR; each line is sanitized by the caller that renders it. */
function blockLines(text: string): string[] {
  return text.replace(ANSI, "").replace(/\r/g, "").split("\n");
}
/** Human duration: `420ms`, `4s`, `1.3s`; never a progress counter. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/** Derives the tool label from its arguments; unknown tools keep their name. */
export function toolLabel(name: string, argumentsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
  } catch {
    return name;
  }
  const path = typeof args.path === "string" ? args.path : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  if (command !== undefined) return `${name === "run_command" ? "command" : name}: ${command}`;
  if (path === undefined) return name;
  if (typeof args.diff !== "string") return `${name} ${path}`;
  const diffLines = args.diff.split("\n");
  const adds = diffLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removes = diffLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return `${name} ${path} (+${adds} −${removes})`;
}

/** Plain-text answer projection; `markdown.tsx` keeps owning the styled Ink rendering. */
function answerLines(markdown: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of markdown.replace(ANSI, "").split(/\r?\n/)) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    const line = raw.trimEnd();
    if (line.trim() === "") out.push("");
    else out.push(fence ? line : line.replace(/^#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "• ").replace(/\*\*|__|`/g, ""));
  }
  while (out.at(-1) === "") out.pop();
  while (out[0] === "") out.shift();
  return out;
}

const GLYPH: Record<TimelineToolStatus, string> = { running: "▸", ok: "✓", failed: "✗" };
const LOGO = ["█▀▀█ █▀▀ ▀█▀ █▀▀█ █▀▀█", "█▄▄█ ▀▀█  █  █▄▄▀ █  █", "▀  ▀ ▀▀▀  ▀  ▀  ▀ ▀▀▀▀"];

function centered(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  return `${" ".repeat(pad)}${text}`;
}

export function renderTimeline(view: TimelineView, width: number): string[] {
  const layout = timelineLayout(width);
  const lines: string[] = [];
  const add = (text: string): void => {
    lines.push(`${layout.indent}${clipLine(inline(text), layout.contentWidth)}`);
  };
  /** Sanitizes first, then indents, so expanded bodies keep their indentation. */
  const addIndented = (text: string): void => {
    const pad = layout.contentWidth > 2 ? "  " : "";
    lines.push(`${layout.indent}${pad}${clipLine(inline(text), layout.contentWidth - pad.length)}`);
  };
  const time = (ms: number | undefined): string =>
    layout.durations && ms !== undefined ? ` · ${formatDuration(ms)}` : "";
  const entry = (item: TimelineEntry): void => {
    switch (item.kind) {
      case "reasoning":
        add(`▸ reasoning${time(item.durationMs)}`);
        if (view.expanded?.reasoning === true) for (const line of blockLines(item.text)) addIndented(line);
        return;
      case "tool": {
        add(`${GLYPH[item.status]} ${toolLabel(item.name, item.arguments)}${time(item.durationMs)}`);
        const body = view.results?.[item.callId];
        if (view.expanded?.tools === true && body !== undefined) {
          for (const line of blockLines(body)) addIndented(line);
        }
        return;
      }
      case "answer":
        for (const line of answerLines(item.markdown)) add(line);
        return;
      case "error":
        add(`✗ ${item.message}`);
        if (item.hint !== undefined) add(`→ ${item.hint}`);
        return;
      case "notice":
        add(`· ${item.message}`);
        return;
    }
  };

  if (view.state.kind === "empty") {
    const logo = layout.blockLogo && layout.contentWidth >= displayWidth(LOGO[0]!) ? LOGO : ["ASTRO"];
    // Static identity: centered padding is kept, so this bypasses `add`'s trim.
    for (const line of logo) lines.push(`${layout.indent}${clipLine(centered(line, layout.contentWidth), layout.contentWidth)}`);
    lines.push("");
  } else {
    if (view.turn !== undefined) {
      add(`> ${view.turn.prompt}`);
      for (const item of view.turn.entries) entry(item);
    }
    if (view.state.kind === "thinking") add(`▸ thinking${time(view.state.elapsedMs)}`);
    if (view.state.kind === "streaming") for (const line of answerLines(view.state.partial)) add(line);
    if (view.state.kind === "error") {
      add(`✗ ${view.state.message}`);
      if (view.state.hint !== undefined) add(`→ ${view.state.hint}`);
    }
    lines.push("");
  }

  if (view.state.kind === "approval") {
    add(view.state.question);
    add(view.state.answerHint ?? "[y] approve · [n] deny · [esc] cancel");
  } else {
    add(COMPOSER_PROMPT);
  }
  const model = layout.fullModel ? view.status.model : (view.status.model.split("/").at(-1) ?? view.status.model);
  const parts = [model, view.status.mode];
  if (view.status.costUsd !== null && view.status.costUsd !== undefined) {
    parts.push(`US$ ${view.status.costUsd.toFixed(6)}`);
  }
  add(parts.join(" · "));
  return lines;
}
