/**
 * Turn lifecycle for the TUI (#595): sending, streaming, queue, attachments,
 * live timeline and the slash-command side effects. Ink-free state stays here;
 * `app.tsx` only composes the screen.
 */
import { useRef, useState, type RefObject } from "react";
import type { SendTurnOptions } from "../chat/agent-session";
import { parseCommand, type ReplCommand } from "../chat/commands";
import type { ChatSession } from "../chat/repl";
import { statusLine } from "../chat/repl";
import type { SessionApi } from "../chat/session-api";
import { isFatalSessionError } from "../chat/session-errors";
import { isYes } from "../chat/approvers";
import { loadAttachment, loadPastedText } from "../attachments/load";
import { attachmentSizeLabel, materializePrompt } from "../attachments/render";
import { readClipboardText } from "../attachments/clipboard";
import { dedupeKey, type LoadedAttachment } from "../attachments/model";
import { formatApprovalPrompt, type AttachmentApprover } from "../attachments/turn";
import { resolveAstroHome } from "../permissions";
import { sanitizeBlockText } from "../sanitize-external";
import { errorLine } from "./error-hint";
import { laneLine } from "./log";
import type { ApprovalBridge } from "./approvals";
import type { ProfileManager } from "../providers/profile-manager";
import { saveTuiConfig, type Theme } from "./theme";
import type { ShellRunner } from "./shell";
import { runCommand, type CommandState, type Entry } from "./commands";
import { createThrottledSink } from "./stream";
import { TimelineTurnStore } from "./timeline-store";
import type { TimelineTurnStatus } from "./timeline";
import { messageOf } from "./entries";

export interface TuiTurnOptions {
  session: ChatSession;
  cwd: string;
  sessionApi?: SessionApi;
  manager?: ProfileManager;
  shell?: ShellRunner;
  approvals?: ApprovalBridge;
  streamThrottleMs: number;
  onTimelineEntry?: (entry: Entry) => void;
  /** History append with the session-state dedupe (#480). */
  append(entries: Entry[]): void;
  /** Raw history append (user, shell and error lines). */
  push(entries: Entry[]): void;
  syncStatus(): void;
  persist(report: boolean): { path?: string; failed: boolean };
  log(line: string): void;
  commandState: RefObject<CommandState>;
  theme: Theme;
  setTheme(theme: Theme): void;
  refreshHealth(): void;
  logSessionHeader(): void;
  openLog(n?: number): void;
  openProviders(screen: { mode: "list" | "add" | "edit" | "remove"; target?: string }): void;
  openConfig(): void;
  openSessions(): void;
  openModelPicker(): void;
  onExit?: () => void;
}

export interface TuiTurn {
  busy: boolean;
  partial: string | undefined;
  queued: number;
  thinkingCollapsed: boolean;
  toolsExpanded: boolean;
  reasoningExpanded: boolean;
  /** Live turn of the running prompt; history entries keep completed turns. */
  liveTimeline: TimelineTurnStore | undefined;
  /** Ref mirror of `busy` for handlers that run before the state commit. */
  busyRef: RefObject<boolean>;
  /** Sends a line and drains the queue when the submission does not open a turn. */
  dispatch(raw: string): Promise<void>;
  /** Queues an Enter typed during a running turn (#560). */
  enqueue(raw: string): void;
  toggleToolOutput(): void;
  toggleThinking(): void;
  finish(): void;
}

export function useTurn(options: TuiTurnOptions): TuiTurn {
  const { session, cwd, shell, approvals, streamThrottleMs, onTimelineEntry } = options;
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<string | undefined>(undefined);
  /** Messages typed during the turn (#560): sent when it ends. */
  const queueRef = useRef<string[]>([]);
  const [queued, setQueued] = useState(0);
  /** Thinking block collapsed with ctrl+t during the stream (#560). */
  const [thinkingCollapsed, setThinkingCollapsed] = useState(false);
  /** Tool output is collapsed by default (ADR-0035); ctrl+o reveals it. */
  const [toolsExpanded, setToolsExpanded] = useState(false);
  /** Reasoning is collapsed by default (ADR-0035); ctrl+t reveals it when emitted. */
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const busyRef = useRef(false);
  const turn = useRef<AbortController | undefined>(undefined);
  const liveTimeline = useRef<TimelineTurnStore | undefined>(undefined);
  /** First message of the live turn: ctrl+o reads bodies from here only. */
  const liveMessagesFrom = useRef(0);
  const [, setTimelineTick] = useState(0);
  const exitRequested = useRef(false);
  const exited = useRef(false);
  const contextInlineRef = useRef(false); // first context warning stays inline (#514)
  const pendingAttachments = useRef<LoadedAttachment[]>([]);

  const refreshTimeline = (): void => setTimelineTick((tick) => tick + 1);

  /** ctrl+o syncs the live bodies before expanding, so output exists while the turn still runs. */
  const toggleToolOutput = (): void => {
    const live = liveTimeline.current;
    if (live !== undefined) {
      live.setResultsFromMessages(session.snapshot().messages.slice(liveMessagesFrom.current));
      refreshTimeline();
    }
    setToolsExpanded((current) => !current);
  };

  /** ctrl+t collapses the thinking block and toggles the reasoning body (#600). */
  const toggleThinking = (): void => {
    setThinkingCollapsed((current) => !current);
    setReasoningExpanded((current) => !current);
  };

  const finish = (): void => {
    if (exited.current) return;
    if (busyRef.current) {
      if (exitRequested.current) {
        // second request: unmount even if the provider does not answer
        exited.current = true;
        options.persist(false);
        options.onExit?.();
        return;
      }
      exitRequested.current = true;
      turn.current?.abort();
      return;
    }
    exited.current = true;
    options.persist(false);
    options.onExit?.();
  };

  const listPending = (): string =>
    pendingAttachments.current.length === 0
      ? "nenhum anexo pendente"
      : pendingAttachments.current
          .map((attachment, index) => `${index + 1}. ${attachment.name} (${attachmentSizeLabel(attachment)})`)
          .join("\n");

  /** Image batch approval on the TUI line; without the bridge it denies (fail closed). */
  const approveAttachment: AttachmentApprover = async (items) =>
    approvals !== undefined && isYes(await approvals.askText(`${formatApprovalPrompt(items)}\naprovar envio? (s/n)`));

  const duplicateMessage = (attachment: LoadedAttachment): string | undefined => {
    const existing = pendingAttachments.current.find((item) => dedupeKey(item) === dedupeKey(attachment));
    return existing === undefined ? undefined : `erro: anexo já adicionado: ${existing.name} (o mesmo anexo já está pendente)`;
  };

  const handleAttachmentCommand = async (command: ReplCommand): Promise<void> => {
    if (command.kind === "attach") {
      if (command.path === undefined) {
        options.push([{ kind: "info", text: listPending() }]);
        return;
      }
      try {
        const loaded = await loadAttachment({
          path: command.path,
          ...(command.range === undefined ? {} : { range: command.range }),
          cwd,
          astroHome: resolveAstroHome(),
          showHidden: session.attachmentsShowHidden?.() === true,
          ...(session.attachmentProtectedPaths === undefined ? {} : { protectedPaths: session.attachmentProtectedPaths() }),
          confirmOutsideCwd: async (absolute) =>
            approvals === undefined
              ? false
              : isYes(await approvals.askText(`anexo fora do cwd: ${absolute} — aprovar? (s/n)`)),
        });
        const duplicate = duplicateMessage(loaded);
        if (duplicate !== undefined) {
          options.push([{ kind: "error", text: duplicate }]);
          return;
        }
        pendingAttachments.current.push(loaded);
        options.push([{ kind: "info", text: `anexo adicionado: ${command.path}\n${listPending()}` }]);
      } catch (error) {
        options.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
      }
      return;
    }
    if (command.kind === "paste") {
      try {
        const pasted = loadPastedText(readClipboardText());
        const duplicate = duplicateMessage(pasted);
        if (duplicate !== undefined) {
          options.push([{ kind: "error", text: duplicate }]);
          return;
        }
        pendingAttachments.current.push(pasted);
        options.push([{ kind: "info", text: `anexo adicionado: clipboard\n${listPending()}` }]);
      } catch (error) {
        options.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
      }
      return;
    }
    if (command.kind === "detach") {
      if (command.target === undefined) {
        options.push([{ kind: "info", text: listPending() }]);
        return;
      }
      if (command.target === "all") {
        pendingAttachments.current = [];
        options.push([{ kind: "info", text: "anexos removidos" }]);
        return;
      }
      const index = Number(command.target);
      if (!Number.isInteger(index) || index < 1 || index > pendingAttachments.current.length) {
        options.push([{ kind: "error", text: `anexo inválido: ${command.target}` }]);
        return;
      }
      pendingAttachments.current.splice(index - 1, 1);
      options.push([{ kind: "info", text: listPending() }]);
    }
  };

  /** Sends `raw` (already cleared from the editor); used by Enter and by the queue drain (#560). */
  const submitText = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (text === "") return;
    if (text.startsWith("!")) {
      const command = text.slice(1);
      options.push([{ kind: "user", text }]);
      if (shell === undefined) {
        options.push([{ kind: "error", text: "shell indisponível" }]);
        return;
      }
      busyRef.current = true;
      const shellTurn = new AbortController();
      turn.current = shellTurn;
      setBusy(true);
      try {
        const result = await shell.run(command, shellTurn.signal);
        // Shell block (#560): command/cwd/exit in the header, output in the body.
        options.push([{
          kind: "shell",
          text: result.output,
          shell: { command, cwd, exitLabel: result.isError ? "erro" : "0", isError: result.isError },
        }]);
      } finally {
        busyRef.current = false;
        turn.current = undefined;
        setBusy(false);
        if (exitRequested.current) finish();
      }
      return;
    }
    // Text with a newline is never a slash command: parseCommand splits on \n
    // and would run the command silently discarding the rest (#63)
    const command: ReplCommand = text.includes("\n") ? { kind: "prompt", text } : parseCommand(text);
    if (command.kind === "empty") return;
    if (command.kind === "exit") {
      finish();
      return;
    }
    if (command.kind === "attach" || command.kind === "paste" || command.kind === "detach") {
      await handleAttachmentCommand(command);
      return;
    }
    if (command.kind === "model" && command.model === undefined) {
      options.openModelPicker();
      return;
    }
    if (command.kind !== "prompt") {
      // `/theme` needs the live theme and the applier that persists TUI state in `$ASTRO_HOME` (#64, #468)
      options.commandState.current.theme = options.theme;
      options.commandState.current.setTheme = options.setTheme;
      const outcome = await runCommand(command, session, options.commandState.current, { cwd, sessionApi: options.sessionApi });
      if (outcome.openLog !== undefined) {
        // /log opens the screen with the buffer; null = everything, n = last n lines (#514)
        options.openLog(outcome.openLog === null ? undefined : outcome.openLog);
        return;
      }
      if (outcome.openProviders !== undefined) {
        if (options.manager === undefined) {
          options.push([{ kind: "error", text: "tela de providers indisponível" }]);
          return;
        }
        options.push(outcome.entries);
        options.openProviders(outcome.openProviders);
        return;
      }
      if (outcome.openConfig === true) {
        if (session.configSummary === undefined) {
          options.push([{ kind: "error", text: "tela de configuração indisponível nesta sessão" }]);
          return;
        }
        options.openConfig();
        return;
      }
      if (outcome.openSessions === true) {
        try {
          options.openSessions();
        } catch (error) {
          options.push([{ kind: "error", text: errorLine(error, messageOf(error)) }]);
        }
        return;
      }
      if (outcome.lastFile !== undefined) options.commandState.current.lastFile = outcome.lastFile ?? undefined;
      const added = [...outcome.entries];
      const modelChanged = (command.kind === "model" && command.model !== undefined)
        || (command.kind === "provider" && command.action === "use" && command.target !== undefined)
        || (command.kind === "resume" && command.ref !== undefined && !outcome.entries.some((entry) => entry.kind === "error"));
      if (modelChanged) {
        try {
          saveTuiConfig(cwd, { lastModel: session.snapshot().model });
        } catch (error) {
          added.push({ kind: "error", text: errorLine(error, messageOf(error)) });
        }
        options.logSessionHeader(); // new session header goes to /log (#514)
        if (command.kind === "provider" && command.action === "use") options.refreshHealth();
      }
      // Only session state dedupes (#480): /help, /usage and /save repeat.
      const stateful = command.kind === "model" || command.kind === "provider"
        || command.kind === "resume" || command.kind === "theme" || command.kind === "mode";
      options.append(stateful ? added.map((entry) => (entry.kind === "info" ? { ...entry, state: true } : entry)) : added);
      options.syncStatus();
      if (outcome.exit) finish();
      return;
    }
    const messagesBefore = session.snapshot().messages.length;
    liveMessagesFrom.current = messagesBefore;
    const timeline = new TimelineTurnStore(`turn-${Date.now()}`, text);
    liveTimeline.current = timeline;
    refreshTimeline();
    busyRef.current = true;
    const controller = new AbortController();
    turn.current = controller;
    setBusy(true);
    // provider deltas pass through the throttle: leading edge + trailing (#64)
    const sink = createThrottledSink({
      intervalMs: streamThrottleMs,
      now: () => Date.now(),
      schedule: (cb, ms) => { setTimeout(cb, ms); },
      emit: (delta) => setPartial((current) => (current ?? "") + delta),
    });
    /** Commits the live turn to history with every tool body available at that point. */
    const commitTimeline = (status: TimelineTurnStatus): Entry => {
      timeline.setResultsFromMessages(session.snapshot().messages.slice(messagesBefore));
      timeline.complete(status);
      liveTimeline.current = undefined;
      refreshTimeline();
      const entry: Entry = { kind: "timeline", text: "", timeline: timeline.turn, results: timeline.results };
      onTimelineEntry?.(entry);
      return entry;
    };
    try {
      const prompt = materializePrompt(command.text, pendingAttachments.current);
      const attachments = pendingAttachments.current;
      const turnOptions: SendTurnOptions = {
        // Live timeline (#635): the observer only updates rendered state.
        observer: (event) => { if (timeline.apply(event)) refreshTimeline(); },
        ...(attachments.length === 0 ? {} : { attachments, approveAttachment }),
      };
      const result = await session.send(
        prompt,
        controller.signal,
        (delta) => sink.add(delta),
        undefined,
        turnOptions,
      );
      pendingAttachments.current = [];
      sink.flush();
      setPartial(undefined);
      // Turn summary leaves the conversation and goes to /log (#514, docs/tui-layout.md), lane [turno] (#560)
      options.log(laneLine("turno", "turno concluído"));
      options.log(laneLine("turno", statusLine(result)));
      const contextNote = result.warning ? `⚠ contexto ${Math.round(result.contextRatio * 100)}% (≥80%)` : undefined;
      if (contextNote !== undefined) {
        // First occurrence stays inline only; repeats go to /log (#514, doc §/log), lane [aviso] (#560)
        if (contextInlineRef.current) options.log(laneLine("aviso", contextNote));
        else contextInlineRef.current = true;
      }
      const timelineEntry = commitTimeline("done");
      options.append([
        timelineEntry,
        { kind: "assistant", text: sanitizeBlockText(result.final) },
        // A warning that changes the answer stays inline once; repetition is state (#480).
        ...(contextNote === undefined ? [] : [{ kind: "info" as const, state: true, text: contextNote }]),
        ...(result.trimmed ? [{ kind: "info" as const, state: true, text: "turno antigo descartado" }] : []),
      ]);
    } catch (error) {
      const timelineEntry = commitTimeline(timeline.status === "running" ? "failed" : timeline.status);
      options.append([
        timelineEntry,
        { kind: "error", text: errorLine(error, messageOf(error)) },
      ]);
      if (isFatalSessionError(error)) exitRequested.current = true;
    } finally {
      if (liveTimeline.current === timeline) {
        options.append([commitTimeline(timeline.status === "running" ? "failed" : timeline.status)]);
      }
      sink.flush(); // invalidate a pending timer: no delta emits after the turn
      setPartial(undefined);
      const saved = options.persist(true);
      if (saved.failed) options.commandState.current.lastFile = undefined;
      else if (saved.path !== undefined) options.commandState.current.lastFile = saved.path;
      options.syncStatus();
      busyRef.current = false;
      turn.current = undefined;
      setBusy(false);
      if (exitRequested.current) finish();
    }
  };

  /** Sends the next queued message, if any (#560). */
  const drainQueue = (): void => {
    const next = queueRef.current.shift();
    setQueued(queueRef.current.length);
    if (next !== undefined) void dispatch(next);
  };

  /**
   * Sends `raw` and, when the submission does not open a turn (slash command),
   * drains the rest of the queue (#560). Long turns drain in their own `finally`.
   */
  const dispatch = async (raw: string): Promise<void> => {
    try {
      await submitText(raw);
    } finally {
      if (!exited.current && !exitRequested.current && !busyRef.current) drainQueue();
    }
  };

  const enqueue = (raw: string): void => {
    const text = raw.trim();
    if (text === "") return;
    queueRef.current.push(text);
    setQueued(queueRef.current.length);
  };

  return {
    busy,
    partial,
    queued,
    thinkingCollapsed,
    toolsExpanded,
    reasoningExpanded,
    liveTimeline: liveTimeline.current,
    busyRef,
    dispatch,
    enqueue,
    toggleToolOutput,
    toggleThinking,
    finish,
  };
}
