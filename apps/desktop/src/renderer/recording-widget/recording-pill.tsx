import { IconNotes } from "@tabler/icons-react";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";
import type { MeetingRuntimeState } from "@/types/meeting";
import { IconButton } from "./icon-button";
import { IconButtonStack } from "./icon-button-stack";
import { WaveformStopAnchor } from "./waveform-stop-anchor";

export interface RecordingPillProps {
  edge: MeetingWidgetEdge;
  meetingState: MeetingRuntimeState;
  level: number;
  onStop: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenNote: () => void;
}

// Recording state has no collapsed/expanded distinction — the layout is
// always at rest in expanded form (Open Note + waveform anchor + drag
// handle). Only the anchor itself toggles waveform → red Stop on its own
// internal hover, owned by WaveformStopAnchor.
export function RecordingPill({
  edge,
  meetingState,
  level,
  onStop,
  onOpenNote,
}: RecordingPillProps) {
  const tooltipSide = edge === "right" ? "left" : "top";

  return (
    <IconButtonStack
      edge={edge}
      secondaryLeading={
        <IconButton
          tooltip="Open Note"
          icon={<IconNotes size={16} stroke={2} />}
          onClick={onOpenNote}
          tooltipSide={tooltipSide}
        />
      }
      mainAnchor={
        <WaveformStopAnchor
          meetingState={meetingState}
          level={level}
          onStop={onStop}
          tooltipSide={tooltipSide}
        />
      }
    />
  );
}
