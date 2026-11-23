/** Tela cheia de configuração do harness (TUI, #273): resumo, troca de `permissions.mode` e revogação de trust (#267). */
import { Box, Text, useInput } from "ink";
import { useState, type ReactElement } from "react";
import { PERMISSION_MODES, type PermissionMode } from "../permissions";
import { configLines, type ConfigSummary } from "../chat/config-summary";
import { CONTROL_ENTRY_WARNING, type EditableConfigKey } from "../core/config-edit";
import { redactSecrets } from "../sanitize-external";
import type { ThemeColors } from "./theme";

export interface ConfigScreenProps {
  colors: ThemeColors;
  summary: ConfigSummary;
  trustedFolders: readonly string[];
  onClose: () => void;
  /** Persiste e aplica o modo; pode jogar (ex.: falha de escrita) — a tela mostra o erro. */
  onSaveMode: (mode: PermissionMode) => void;
  /** Revoga uma pasta confiável (#267); `false` = não estava na lista; pode jogar. */
  onRevokeTrust?: (dir: string) => boolean;
  /** Grava um knob editável e persiste (#558); pode jogar — a tela mostra o erro. */
  onSaveKnob?: (key: EditableConfigKey, rawValue: string) => void;
}

type View = "main" | "pick" | "confirm" | "revoke" | "revoke-confirm" | "edit" | "edit-value";

export function ConfigScreen({ colors, summary, trustedFolders, onClose, onSaveMode, onRevokeTrust, onSaveKnob }: ConfigScreenProps): ReactElement {
  const [view, setView] = useState<View>("main");
  const [mode, setMode] = useState<PermissionMode>(summary.permissionMode);
  const [cursor, setCursor] = useState(() => Math.max(0, PERMISSION_MODES.indexOf(summary.permissionMode)));
  const [folders, setFolders] = useState<readonly string[]>(trustedFolders);
  const [revokeCursor, setRevokeCursor] = useState(0);
  const [knobCursor, setKnobCursor] = useState(0);
  const [knobDraft, setKnobDraft] = useState("");
  const [message, setMessage] = useState<{ text: string; ok: boolean } | undefined>(undefined);

  const save = (next: PermissionMode): void => {
    try {
      onSaveMode(next);
      setMode(next);
      setMessage({ text: `modo salvo: ${next} (gravado na config)`, ok: true });
    } catch (error) {
      setMessage({ text: `erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, ok: false });
    }
    setView("main");
  };

  const saveKnob = (key: EditableConfigKey, rawValue: string): void => {
    try {
      if (onSaveKnob === undefined) throw new Error("esta tela não aceita editar knobs");
      onSaveKnob(key, rawValue);
      setMessage({ text: `salvo: ${key} = ${rawValue} (gravado na config)${key === "preset" && rawValue.trim() === "control" ? `\n${CONTROL_ENTRY_WARNING}` : ""}`, ok: true });
    } catch (error) {
      setMessage({ text: `erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, ok: false });
    }
    setView("main");
  };

  const revoke = (folder: string): void => {
    try {
      if (onRevokeTrust === undefined) throw new Error("esta tela não aceita revogar trust");
      if (onRevokeTrust(folder)) {
        setFolders((current) => current.filter((entry) => entry !== folder));
        setMessage({ text: `trust revogado: ${folder}`, ok: true });
      } else {
        setMessage({ text: `pasta não estava na lista: ${folder}`, ok: false });
      }
    } catch (error) {
      setMessage({ text: `erro: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, ok: false });
    }
    setView("main");
  };

  useInput((value, key) => {
    if (key.ctrl && (value === "c" || value === "d")) {
      onClose();
      return;
    }
    if (key.escape) {
      if (view === "main") onClose();
      else setView("main");
      return;
    }
    if (view === "main") {
      if (key.return || value === "m") {
        setMessage(undefined);
        setCursor(Math.max(0, PERMISSION_MODES.indexOf(mode)));
        setView("pick");
      } else if (value === "r") {
        setMessage(undefined);
        if (folders.length === 0) setMessage({ text: "nenhuma pasta confiável para revogar", ok: false });
        else {
          setRevokeCursor(0);
          setView("revoke");
        }
      } else if (value === "e") {
        setMessage(undefined);
        if (onSaveKnob === undefined || summary.knobs.length === 0) setMessage({ text: "nenhum knob editável nesta sessão", ok: false });
        else {
          setKnobCursor(0);
          setView("edit");
        }
      }
      return;
    }
    if (view === "edit") {
      if (key.upArrow) setKnobCursor((current) => Math.max(0, current - 1));
      else if (key.downArrow) setKnobCursor((current) => Math.min(summary.knobs.length - 1, current + 1));
      else if (key.return) {
        setKnobDraft(summary.knobs[knobCursor]?.value ?? "");
        setView("edit-value");
      }
      return;
    }
    if (view === "edit-value") {
      const knob = summary.knobs[knobCursor];
      if (key.backspace) setKnobDraft((current) => current.slice(0, -1));
      else if (key.return) {
        if (knob !== undefined) saveKnob(knob.key, knobDraft);
      } else if (!key.ctrl && !key.meta && value !== "") setKnobDraft((current) => current + value);
      return;
    }
    if (view === "pick") {
      if (key.upArrow) setCursor((current) => Math.max(0, current - 1));
      else if (key.downArrow) setCursor((current) => Math.min(PERMISSION_MODES.length - 1, current + 1));
      else if (key.return) {
        const next = PERMISSION_MODES[cursor]!;
        if (next === "bypass") setView("confirm"); // bypass é perigoso: exige confirmação explícita
        else save(next);
      }
      return;
    }
    if (view === "revoke") {
      if (key.upArrow) setRevokeCursor((current) => Math.max(0, current - 1));
      else if (key.downArrow) setRevokeCursor((current) => Math.min(folders.length - 1, current + 1));
      else if (key.return) {
        if (folders[revokeCursor] !== undefined) setView("revoke-confirm");
      }
      return;
    }
    if (view === "revoke-confirm") {
      if (value === "c") revoke(folders[revokeCursor]!);
      else if (value === "x") {
        setMessage(undefined);
        setView("main");
      }
      return;
    }
    // view === "confirm" (bypass)
    if (value === "c") save("bypass");
    else if (value === "x") {
      setMessage(undefined);
      setView("main");
    }
  });

  const shown: ConfigSummary = { ...summary, permissionMode: mode };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text bold color={colors.accent}>Configuração</Text>
      {view === "main" ? (
        <>
          {configLines(shown, folders).map((line) => <Text key={line}>{line}</Text>)}
          {message === undefined ? null : (
            <Text color={message.ok ? colors.accent : colors.error}>{message.text}</Text>
          )}
          <Text dimColor>enter/m: trocar permissions.mode · e: editar knob · r: revogar trust · esc: fechar</Text>
        </>
      ) : null}
      {view === "pick" ? (
        <>
          <Text>permissions.mode:</Text>
          {PERMISSION_MODES.map((option, index) => (
            <Text key={option} color={index === cursor ? colors.accent : undefined}>
              {index === cursor ? "→" : " "} {option}{option === mode ? " (ativo)" : ""}
            </Text>
          ))}
          <Text dimColor>↑/↓: escolher · enter: aplicar (bypass pede confirmação) · esc: voltar</Text>
        </>
      ) : null}
      {view === "confirm" ? (
        <>
          <Text color={colors.error}>bypass: tools executam sem aprovação humana. Confirmar?</Text>
          <Text dimColor>c: confirmar e salvar · x/esc: cancelar</Text>
        </>
      ) : null}
      {view === "revoke" ? (
        <>
          <Text>pasta confiável a revogar:</Text>
          {folders.map((folder, index) => (
            <Text key={folder} color={index === revokeCursor ? colors.accent : undefined}>
              {index === revokeCursor ? "→" : " "} {folder}
            </Text>
          ))}
          <Text dimColor>↑/↓: escolher · enter: pedir confirmação · esc: voltar</Text>
        </>
      ) : null}
      {view === "edit" ? (
        <>
          <Text>knob editável (valor atual):</Text>
          {summary.knobs.map((knob, index) => (
            <Text key={knob.key} color={index === knobCursor ? colors.accent : undefined}>
              {index === knobCursor ? "→" : " "} {knob.key}: {knob.value}
            </Text>
          ))}
          <Text dimColor>↑/↓: escolher · enter: editar valor · esc: voltar</Text>
        </>
      ) : null}
      {view === "edit-value" ? (
        <>
          <Text>{summary.knobs[knobCursor]?.key} (atual: {summary.knobs[knobCursor]?.value}):</Text>
          <Text color={colors.accent}>{knobDraft}</Text>
          <Text dimColor>digite o valor · enter: salvar e gravar · esc: voltar</Text>
        </>
      ) : null}
      {view === "revoke-confirm" ? (
        <>
          <Text color={colors.error}>revogar trust de "{folders[revokeCursor]}"? o próximo open/run desta pasta pergunta de novo, se nenhuma ancestral continuar confiável.</Text>
          <Text dimColor>c: confirmar · x/esc: cancelar</Text>
        </>
      ) : null}
    </Box>
  );
}
