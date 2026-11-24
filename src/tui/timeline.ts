/**
 * Pure timeline renderer (#595): maps conversation state to terminal lines.
 * No Ink import, no TTY, no I/O; the Ink zones only compose these strings.
 * Contract: docs/adr/0035-tui-timeline.md.
 */
import { sanitizeBlockLine, sanitizeBlockText, sanitizePromptText, stripAnsi } from "../sanitize-external";

export type TimelineToolStatus = "running" | "ok" | "failed";
export type TimelineTurnStatus = "running" | "done" | "failed" | "cancelled";

export type TimelineEntry =
  | { kind: "reasoning"; text: string; durationMs?: number }
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
  /** Tool bodies by `callId` (the id on `tool.start` and `tool.end`); read only when expanded. */
  readonly results?: Readonly<Record<string, string>>;
}

export const COMPOSER_PROMPT = "❯";

/** Width bands from the TUIX spec: 120+, 80–119, 60–79, below 60. */
export function timelineLayout(width: number) {
  const w = Math.max(1, Math.floor(width));
  if (w >= 120) {
    return { contentWidth: Math.min(100, w - 2), indent: "  ", durations: true, fullModel: true, blockLogo: true };
  }
  if (w >= 80) return { contentWidth: w, indent: "", durations: true, fullModel: true, blockLogo: true };
  if (w >= 60) return { contentWidth: w - 2, indent: "  ", durations: false, fullModel: false, blockLogo: true };
  return { contentWidth: w, indent: "", durations: false, fullModel: false, blockLogo: false };
}

/** East Asian wide/emoji, and the East-Asian-Ambiguous glyphs this renderer emits, take two columns. */
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}]/u;
const AMBIGUOUS = /[·•…→▸▀▄█✓✔✗❯]/;

function cellWidth(char: string): number {
  return WIDE.test(char) || AMBIGUOUS.test(char) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) total += cellWidth(char);
  return total;
}

export function clipLine(text: string, max: number): string {
  if (max < cellWidth("…")) return "";
  if (displayWidth(text) <= max) return text;
  const budget = max - cellWidth("…");
  let out = "";
  let used = 0;
  for (const char of text) {
    const step = cellWidth(char);
    if (used + step > budget) break;
    out += char;
    used += step;
  }
  return `${out}…`;
}

/** One-line field: invisible marks and secrets removed (I-03), whitespace collapsed. */
function inline(text: string): string {
  return sanitizePromptText(text).replace(/\s+/g, " ").trim();
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

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
  for (const raw of stripAnsi(markdown).split(/\r?\n/)) {
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
export function renderTimeline(view: TimelineView, width: number): string[] {
  const layout = timelineLayout(width);
  const lines: string[] = [];
  const add = (text: string): void => {
    lines.push(`${layout.indent}${clipLine(inline(text), layout.contentWidth)}`);
  };
  /** Sanitizes per line, then indents, so block indentation and relative indent survive. */
  const addBlock = (text: string, pad = ""): void => {
    lines.push(`${layout.indent}${pad}${clipLine(sanitizeBlockLine(text), layout.contentWidth - pad.length)}`);
  };
  const time = (ms: number | undefined): string =>
    layout.durations && ms !== undefined ? ` · ${formatDuration(ms)}` : "";
  const entry = (item: TimelineEntry): void => {
    switch (item.kind) {
      case "reasoning":
        add(`▸ reasoning${time(item.durationMs)}`);
        // Whole-block redaction before splitting: a multi-line secret dies here (I-03).
        if (view.expanded?.reasoning === true) for (const line of sanitizeBlockText(item.text).split("\n")) addBlock(line, "  ");
        return;
      case "tool": {
        add(`${GLYPH[item.status]} ${toolLabel(item.name, item.arguments)}${time(item.durationMs)}`);
        const body = view.results !== undefined && Object.hasOwn(view.results, item.callId) ? view.results[item.callId] : undefined;
        if (view.expanded?.tools === true && body !== undefined) {
          for (const line of body.replace(/\r/g, "").split("\n")) addBlock(line, "  ");
        }
        return;
      }
      case "answer":
        for (const line of answerLines(item.markdown)) addBlock(line);
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
    // One pad from the widest line: the block stays centered and aligned in both width models.
    const pad = Math.max(0, Math.floor((layout.contentWidth - Math.max(...logo.map(displayWidth))) / 2));
    for (const line of logo) lines.push(`${layout.indent}${" ".repeat(pad)}${clipLine(line, layout.contentWidth - pad)}`);
    lines.push("");
  } else {
    if (view.turn !== undefined) {
      add(`> ${view.turn.prompt}`);
      for (const item of view.turn.entries) entry(item);
    }
    if (view.state.kind === "thinking") add(`▸ thinking${time(view.state.elapsedMs)}`);
    if (view.state.kind === "streaming") for (const line of answerLines(view.state.partial)) addBlock(line);
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

/** The four TUIX zones (#635), split from the rendered frame so Ink only joins strings. */
export interface TimelineZones {
  readonly identity: readonly string[];
  readonly timeline: readonly string[];
  readonly composer: readonly string[];
  readonly status: readonly string[];
}

export function renderTimelineZones(view: TimelineView, width: number): TimelineZones {
  const lines = renderTimeline(view, width);
  // Status is always last; composer is one line, two while an approval owns it.
  const composerLength = view.state.kind === "approval" ? 2 : 1;
  const boundary = lines.length - 1 - composerLength;
  const body = lines.slice(0, boundary);
  return {
    identity: view.state.kind === "empty" ? body : [],
    timeline: view.state.kind === "empty" ? [] : body,
    composer: lines.slice(boundary, boundary + composerLength),
    status: lines.slice(boundary + composerLength),
  };
}
