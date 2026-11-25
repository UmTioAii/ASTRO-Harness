/**
 * Keyboard contract of the composer screen (#595): approval answers, expansions,
 * leader keys, completions, multi-line editing and Enter/queue. Screens own
 * their own keys; this hook only runs when no screen is open.
 */
import { useInput } from "ink";
import { useRef, type RefObject } from "react";
import type { SessionApi } from "../chat/session-api";
import type { ChatSession } from "../chat/repl";
import type { ApprovalBridge, ApprovalQuestion } from "./approvals";
import type { Entry } from "./commands";
import { applyCompletion, enterAction } from "./editor";
import { indexFiles } from "./files";
import { LEADER, runKeybind } from "./keybinds";
import type { Theme } from "./theme";

export interface TuiKeyOptions {
  /** A full-screen screen owns the input; the composer ignores keys. */
  suspended: boolean;
  approvals?: ApprovalBridge;
  question?: ApprovalQuestion;
  diffOpen: RefObject<boolean>;
  openDiff(): void;
  busy: boolean;
  /** Mirrors `busy` before the state commit, same guard as the old handler (#560). */
  busyRef: RefObject<boolean>;
  dispatch(raw: string): Promise<void>;
  enqueue(raw: string): void;
  toggleToolOutput(): void;
  toggleThinking(): void;
  finish(): void;
  session: ChatSession;
  sessionApi?: SessionApi;
  theme: Theme;
  append(entries: Entry[]): void;
  setTheme(theme: Theme): void;
  inputRef: RefObject<string>;
  setInput(update: (current: string) => string): void;
  suggestions: readonly string[];
  selectedIndex: number;
  setSelected(value: number): void;
  cwd: string;
  setFiles(files: string[]): void;
}

export function useTuiKeys(options: TuiKeyOptions): void {
  const { approvals, question, inputRef, setInput, suggestions, selectedIndex } = options;
  const leader = useRef(false);

  /** Enter in the editor: clear the line and send; during a turn it joins the queue (#560). */
  const submit = (): void => {
    const text = inputRef.current.trim();
    if (text === "") return;
    setInput(() => "");
    void options.dispatch(text);
  };

  useInput((value, key) => {
    if (options.suspended) return;
    const ctrl = key.ctrl === true;
    if (ctrl && (value === "c" || value === "d")) {
      approvals?.answer("");
      options.finish();
      return;
    }
    if (question !== undefined) {
      if (key.tab && question.diff !== undefined && !options.diffOpen.current) {
        // tab opens the edit-tool diff overlay without swallowing the answer line (#64 D2)
        options.diffOpen.current = true;
        options.openDiff();
        return;
      }
      if (key.return) {
        const answer = inputRef.current;
        setInput(() => "");
        approvals?.answer(answer);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && !key.escape) {
        const clean = value.replace(/[\r\n]/g, "");
        if (clean !== "") setInput((current) => current + clean);
      }
      return;
    }
    // #560: the editor stays editable during the turn; Enter enqueues the message.
    const streaming = options.busy || options.busyRef.current;
    if (streaming) leader.current = false; // the leader does not apply during a stream
    if (ctrl && value === "o") {
      // ctrl+o expands the tool bodies, redacted and keyed by callId (#635)
      options.toggleToolOutput();
      return;
    }
    if (ctrl && value === "t") {
      // ctrl+t collapses the thinking block and reveals the reasoning timeline (#600).
      options.toggleThinking();
      return;
    }
    if (!streaming && leader.current) {
      leader.current = false;
      runKeybind(`${LEADER} ${value.toLowerCase()}`, {
        session: options.session,
        ...(options.sessionApi === undefined ? {} : { sessionApi: options.sessionApi }),
        theme: options.theme,
        addEntries: (added) => options.append(added),
        setTheme: options.setTheme,
        finish: options.finish,
      });
      return;
    }
    if (!streaming && ctrl && value === "x") {
      leader.current = true;
      return;
    }
    if (suggestions.length > 0) {
      if (key.tab) {
        setInput(() => applyCompletion(inputRef.current, suggestions[selectedIndex]!));
        options.setSelected(0);
        return;
      }
      if (key.upArrow) {
        options.setSelected((selectedIndex - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        options.setSelected((selectedIndex + 1) % suggestions.length);
        return;
      }
    }
    if (key.return && key.shift) {
      // shift+enter (kitty protocol, CSI 13;2u): newline in the editor (#63)
      setInput((current) => `${current}\n`);
      options.setSelected(0);
      return;
    }
    if (value === "\n") {
      // legacy linefeed (shift+enter in a terminal without kitty) also breaks the line (#63)
      setInput((current) => `${current}\n`);
      options.setSelected(0);
      return;
    }
    if (key.return) {
      const suggestion = suggestions.length > 0 ? suggestions[selectedIndex] : undefined;
      if (suggestion !== undefined && enterAction(inputRef.current, suggestion) === "apply-completion") {
        // #471: the first Enter applies the completion; the next confirms and runs
        setInput(() => applyCompletion(inputRef.current, suggestion));
        options.setSelected(0);
        return;
      }
      if (streaming) {
        // #560: during the turn the message joins the queue, sent when the turn ends
        if (inputRef.current.trim() !== "") options.enqueue(inputRef.current);
        setInput(() => "");
        return;
      }
      submit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      options.setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape) {
      const clean = value.replace(/[\r\n]/g, "");
      if (clean !== "") {
        const before = inputRef.current;
        setInput((current) => current + clean);
        options.setSelected(0);
        if (!before.includes("@") && `${before}${clean}`.includes("@")) options.setFiles(indexFiles(options.cwd));
      }
    }
  });
}
