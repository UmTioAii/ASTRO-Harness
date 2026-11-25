/** One history entry, rendered from the store shape (#480, #595, #635). */
import { Box, Text, useWindowSize } from "ink";
import type { ReactElement } from "react";
import type { SessionSnapshot } from "../chat/agent-session";
import { redactSecrets } from "../sanitize-external";
import type { Entry } from "./commands";
import { Markdown } from "./markdown";
import type { ThemeColors } from "./theme";
import type { TimelineView } from "./timeline";
import { TimelineZone } from "./timeline-zones";

export interface Status {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

export function statusOf(snapshot: SessionSnapshot): Status {
  return {
    model: snapshot.model,
    tokensIn: snapshot.tokensIn,
    tokensOut: snapshot.tokensOut,
    costUsd: snapshot.costUsd,
  };
}

/** Error text always leaves through the redactor (I-03). */
export function messageOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function EntryLine({
  entry,
  colors,
  expanded,
}: {
  entry: Entry;
  colors: ThemeColors;
  expanded?: TimelineView["expanded"];
}): ReactElement {
  const { columns } = useWindowSize();
  const width = columns !== undefined && columns > 0 ? columns : 80;
  if (entry.kind === "timeline" && entry.timeline !== undefined) {
    const view = {
      state: { kind: "done" as const },
      status: { model: "", mode: "" },
      turn: entry.timeline,
      ...(entry.results === undefined ? {} : { results: entry.results }),
      ...(expanded === undefined ? {} : { expanded }),
    };
    return <TimelineZone view={view} width={width} zone="timeline" />;
  }
  if (entry.kind === "user") return <Text color={colors.accent}>{"> "}{entry.text}</Text>;
  if (entry.kind === "assistant") return <Markdown text={entry.text} />;
  if (entry.kind === "error") return <Text color={colors.error}>{entry.text}</Text>;
  if (entry.kind === "shell") {
    // Shell block (#560): header with command/cwd/exit and the body with the output.
    const meta = entry.shell;
    const tone = meta?.isError === true ? colors.error : colors.accent;
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
        <Text color={tone}>
          {"$ "}{meta?.command ?? entry.text}
          {meta === undefined ? null : <Text dimColor>{`  ·  cwd: ${meta.cwd} · exit: ${meta.exitLabel}`}</Text>}
        </Text>
        <Text color={meta?.isError === true ? colors.error : undefined}>{entry.text}</Text>
      </Box>
    );
  }
  return <Text dimColor>{entry.text}</Text>;
}
