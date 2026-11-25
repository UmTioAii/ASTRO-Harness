/** Composer zone (#595): input box, approval takeover, hint and completions. */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { sanitizePromptText } from "../sanitize-external";
import { commandDescription } from "./editor";
import type { ThemeColors } from "./theme";

export interface ComposerProps {
  colors: ThemeColors;
  mode: string;
  question?: { text: string; diff?: { path: string; content: string } };
  input: string;
  inputLines: readonly string[];
  composerMark: string;
  busy: boolean;
  suggestions: readonly string[];
  selectedIndex: number;
  win: { start: number; end: number };
}

export function Composer({
  colors, mode, question, input, inputLines, composerMark, busy, suggestions, selectedIndex, win,
}: ComposerProps): ReactElement {
  const visibleSuggestions = suggestions.slice(win.start, win.end);
  return (
    <>
      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={question !== undefined ? colors.warning : mode === "bypass" ? colors.error : colors.accent}
        paddingX={1}
        flexDirection="column"
      >
        {question === undefined
          ? inputLines.map((line, index) => (
              <Box key={index}>
                <Text color={colors.accent}>{index === 0 ? `${composerMark} ` : "  "}</Text>
                <Text>{line}</Text>
                {index === inputLines.length - 1 ? <Text inverse> </Text> : null}
              </Box>
            ))
          : (
            <>
              {/* The question wraps in Ink; clipping it could hide the dangerous tail of a command (#635). */}
              <Text color={colors.warning}>
                {sanitizePromptText(question.text.replace(/\r?\n/g, " "))}
                {question.diff === undefined ? null : " · tab ver diff"}
              </Text>
              {input === ""
                ? <Text dimColor>{"enter responde · ctrl+c cancela"}</Text>
                : (
                  <Text>
                    <Text color={colors.accent}>{"❯ "}</Text>
                    {sanitizePromptText(input)}▏
                  </Text>
                )}
            </>
          )}
      </Box>
      {question === undefined ? (
        <Text dimColor>
          {busy ? "  enter entra na fila · ctrl+t recolhe pensamento · shift+enter nova linha" : "  enter envia · shift+enter nova linha"}
        </Text>
      ) : null}
      {win.start > 0 ? <Text dimColor>  …</Text> : null}
      {visibleSuggestions.map((item, offset) => {
        const index = win.start + offset;
        const isSelected = index === selectedIndex;
        const description = commandDescription(item);
        return (
          <Text key={item} {...(isSelected ? { color: colors.accent } : { dimColor: true })}>
            {isSelected ? "> " : "  "}{item}
            {description === undefined ? null : <Text dimColor>{`  ${description}`}</Text>}
          </Text>
        );
      })}
      {win.end < suggestions.length ? <Text dimColor>  …</Text> : null}
    </>
  );
}
