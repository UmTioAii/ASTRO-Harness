/**
 * Tela `/log` (#514, docs/tui-layout.md §/log): cabeçalho da sessão (versão,
 * provider/modelo e endpoint) + buffer de log em memória. Só memória — a fonte
 * durável continua sendo audit/ledger. esc/ctrl+c voltam para a conversa.
 */
import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { sanitizeLogLine } from "./log";
import type { ThemeColors } from "./theme";

export interface LogScreenProps {
  colors: ThemeColors;
  /** Cabeçalho da sessão (já sanitizado por sessionHeaderLine). */
  header: string;
  /** Linhas do buffer já fatiadas por tailLog. */
  lines: readonly string[];
  onClose(): void;
}

export function LogScreen({ colors, header, lines, onClose }: LogScreenProps): ReactElement {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === "c" || input === "d"))) onClose();
  });
  return (
    <Box flexDirection="column">
      <Text bold>{sanitizeLogLine(header)}</Text>
      <Text dimColor>log da sessão (memória)</Text>
      {lines.length === 0 ? (
        <Text dimColor>log vazio</Text>
      ) : (
        // defesa em depth (I-03): o buffer já vem sanitizado, a tela re-sanitiza no render
        lines.map((line, index) => <Text key={index}>{sanitizeLogLine(line)}</Text>)
      )}
      <Text dimColor>esc voltar</Text>
    </Box>
  );
}
