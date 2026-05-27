import { IconNotes } from "@tabler/icons-react";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";
import type { MeetingRuntimeState } from "@/types/meeting";
import { IconButton } from "./icon-button";
import { WaveformStopAnchor } from "./waveform-stop-anchor";
import { DragHandle } from "./drag-handle";

export interface RecordingPillProps {
  edge: MeetingWidgetEdge;
  meetingState: MeetingRuntimeState;
  level: number;
  onStop: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenNote: () => void;
  showHandle: boolean;
  onDragStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

// Recording state always lives in its expanded form — same 36×36 frame
// as the idle pill, with Open Note + drag handle around it. The frame
// position never changes; only the anchor's internal waveform↔stop swap
// reacts to hover.
const FRAME = 36;
const GAP = 6;
const OPEN_NOTE = 36;
const HANDLE_SHORT = 18;

export function RecordingPill({
  edge,
  meetingState,
  level,
  onStop,
  onOpenNote,
  showHandle,
  onDragStart,
}: RecordingPillProps) {
  const isVertical = edge === "right";
  const tooltipSide = isVertical ? "left" : "top";

  const openNoteStyle = isVertical
    ? { right: 0, top: -(OPEN_NOTE + GAP) }
    : { right: -(OPEN_NOTE + GAP), top: 0 };
  const handleStyle = isVertical
    ? {
        bottom: -(HANDLE_SHORT + GAP),
        left: "50%",
        transform: "translateX(-50%)",
      }
    : {
        right: -(HANDLE_SHORT + GAP),
        top: "50%",
        transform: "translateY(-50%)",
      };

  return (
    <div
      className="relative"
      style={{ width: FRAME, height: FRAME }}
      data-hit-zone="true"
    >
      {/* Waveform / Stop anchor — always present, owns its own
          internal hover state for the waveform→Stop swap. */}
      <div className="absolute inset-0">
        <WaveformStopAnchor
          meetingState={meetingState}
          level={level}
          onStop={onStop}
          tooltipSide={tooltipSide}
        />
      </div>

      {/* Open Note — always rendered while recording. */}
      <div className="absolute" style={openNoteStyle}>
        <IconButton
          tooltip="Open Note"
          icon={<IconNotes size={16} stroke={2} />}
          onClick={onOpenNote}
          tooltipSide={tooltipSide}
        />
      </div>

      {/* Drag handle — always visible while recording. */}
      <div className="absolute" style={handleStyle}>
        <DragHandle edge={edge} visible={showHandle} onPointerDown={onDragStart} />
      </div>
    </div>
  );
}
