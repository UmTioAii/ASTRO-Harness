/** Ink renderer for the shared provider wizard (#629): no form state of its own. */
import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ProfileManager, ProfileView } from "../providers/profile-manager";
import { runProviderWizard, type WizardIO } from "../chat/provider-wizard";
import type { ThemeColors } from "./theme";

type Prompt =
  | { kind: "text"; label: string; secret: boolean }
  | { kind: "select"; label: string; options: readonly string[]; index: number };

export interface ProviderWizardFormProps {
  manager: ProfileManager;
  colors: ThemeColors;
  /** Edit target; absent = add. */
  profile?: ProfileView;
  saveSecret?: (providerId: string, secret: string) => string;
  discardSecret?: (ref: string) => void;
  onSaved: (saved: ProfileView) => void;
  onCancel: () => void;
  onFailed: (lines: string) => void;
}

export function ProviderWizardForm({
  manager, colors, profile, saveSecret, discardSecret, onSaved, onCancel, onFailed,
}: ProviderWizardFormProps): ReactElement {
  const [prompt, setPrompt] = useState<Prompt | undefined>();
  const [value, setValue] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const promptRef = useRef<Prompt | undefined>(undefined);
  const valueRef = useRef("");
  const pending = useRef<((answer: string | number | null) => void) | undefined>(undefined);
  const cancelled = useRef(false);
  const started = useRef(false);
  const linesRef = useRef<string[]>([]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const show = (next: Prompt): void => {
      promptRef.current = next;
      setPrompt(next);
    };
    const io: WizardIO = {
      read: (label, opts) => new Promise((resolve) => {
        pending.current = (answer) => resolve(typeof answer === "string" || answer === null ? answer : null);
        valueRef.current = "";
        setValue("");
        show({ kind: "text", label, secret: opts?.secret === true });
      }),
      select: (label, options, initial = 0) => new Promise((resolve) => {
        pending.current = (answer) => resolve(typeof answer === "number" ? answer : null);
        valueRef.current = "";
        setValue("");
        show({ kind: "select", label, options, index: initial });
      }),
      write: (text) => {
        linesRef.current = [...linesRef.current, ...text.split("\n")];
        setLines(linesRef.current);
      },
    };
    void runProviderWizard(io, manager, {
      mode: profile === undefined ? "add" : "edit",
      ...(profile === undefined ? {} : { profile }),
      ...(saveSecret === undefined ? {} : { saveSecret }),
      ...(discardSecret === undefined ? {} : { discardSecret }),
      activate: "never",
    }).then((saved) => {
      if (saved !== undefined) {
        onSaved(saved);
        return;
      }
      if (cancelled.current) onCancel();
      else onFailed(linesRef.current.join("\n"));
    }).catch((error: unknown) => {
      onFailed(error instanceof Error ? error.message : String(error));
    });
  }, []);

  const answer = (next: string | number | null): void => {
    const resolve = pending.current;
    pending.current = undefined;
    promptRef.current = undefined;
    setPrompt(undefined);
    resolve?.(next);
  };

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) {
      cancelled.current = true;
      if (pending.current !== undefined) answer(null);
      else onCancel();
      return;
    }
    if (promptRef.current === undefined) {
      if (key.escape) onCancel();
      return;
    }
    if (key.escape) {
      cancelled.current = true;
      answer(null);
      return;
    }
    const current = promptRef.current;
    if (current.kind === "select") {
      const move = (next: number): void => {
        const updated = { ...current, index: Math.max(0, Math.min(current.options.length - 1, next)) };
        promptRef.current = updated;
        setPrompt(updated);
      };
      if (key.upArrow) { move(current.index - 1); return; }
      if (key.downArrow) { move(current.index + 1); return; }
      if (key.return) answer(current.index);
      return;
    }
    if (key.return) { answer(valueRef.current); return; }
    if (key.backspace || key.delete) {
      valueRef.current = valueRef.current.slice(0, -1);
      setValue(valueRef.current);
      return;
    }
    if (input !== "") {
      valueRef.current += input;
      setValue(valueRef.current);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{profile === undefined ? "Novo provider" : `Editar ${profile.id}`}</Text>
      {lines.map((line, index) => <Text key={index}>{line}</Text>)}
      {prompt?.kind === "select" ? (
        <Box flexDirection="column">
          <Text>{prompt.label}</Text>
          {prompt.options.map((option, index) => (
            <Text key={option} color={index === prompt.index ? colors.accent : undefined}>
              {index === prompt.index ? "> " : "  "}{option}
            </Text>
          ))}
          <Text dimColor>↑↓ escolher · enter continuar · esc cancelar</Text>
        </Box>
      ) : prompt === undefined ? null : (
        <Box flexDirection="column">
          <Text>{prompt.label}</Text>
          <Text color={colors.accent}>{prompt.secret ? "*".repeat(value.length) : value} </Text>
          <Text dimColor>enter continuar · esc cancelar</Text>
        </Box>
      )}
    </Box>
  );
}
