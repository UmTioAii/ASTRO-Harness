/**
 * Ink shell for the pure timeline (#635): the four zones render the strings from
 * `renderTimelineZones`; composition and formatting stay in `timeline.ts`.
 */
import { Text } from "ink";
import type { ReactElement } from "react";
import { renderTimelineZones, type TimelineView } from "./timeline";

export type TimelineZoneName = keyof ReturnType<typeof renderTimelineZones>;

export interface TimelineZoneProps {
  view: TimelineView;
  width: number;
  zone: TimelineZoneName;
  dimColor?: boolean;
}

/** One zone, used by `app.tsx` to place identity, timeline, composer and status. */
export function TimelineZone({ view, width, zone, dimColor }: TimelineZoneProps): ReactElement {
  const zoneLines = renderTimelineZones(view, width)[zone];
  return (
    <>
      {zoneLines.map((line, index) => (
        <Text key={index} dimColor={dimColor}>{line === "" ? " " : line}</Text>
      ))}
    </>
  );
}

/** All four zones in order, for a full timeline frame (tests and the next slice). */
export function TimelineZones({ view, width }: { view: TimelineView; width: number }): ReactElement {
  return (
    <>
      {(["identity", "timeline", "composer", "status"] as const).map((zone) => (
        <TimelineZone key={zone} view={view} width={width} zone={zone} />
      ))}
    </>
  );
}
