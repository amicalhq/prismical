import { motion } from "framer-motion";
import { AlertTriangle, Loader2, Square } from "lucide-react";
import { IconNotes } from "@tabler/icons-react";
import { Waveform } from "@/components/Waveform";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";
import type { MeetingRuntimeState } from "@/types/meeting";
import { IconButton } from "./icon-button";
import { IconButtonStack } from "./icon-button-stack";
import { PILL_SHELL_CLASS } from "./idle-pill";

const NUM_WAVEFORM_BARS_HOVERED = 6;
const NUM_WAVEFORM_BARS_COLLAPSED = 4;

export interface RecordingPillProps {
  edge: MeetingWidgetEdge;
  hovered: boolean;
  meetingState: MeetingRuntimeState;
  level: number;
  onStop: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenNote: () => void;
}

export function RecordingPill({
  edge,
  hovered,
  meetingState,
  level,
  onStop,
  onOpenNote,
}: RecordingPillProps) {
  const isError = meetingState === "error";
  const isStarting = meetingState === "starting";
  const isStopping = meetingState === "stopping";
  const isBusy = isStarting || isStopping;

  const waveformContent = (
    <div
      className={`flex flex-none items-center justify-center gap-[2.5px] ${hovered ? "h-[18px]" : "h-4"}`}
    >
      {Array.from({
        length: hovered ? NUM_WAVEFORM_BARS_HOVERED : NUM_WAVEFORM_BARS_COLLAPSED,
      }).map((_, index) => (
        <Waveform
          key={index}
          index={index}
          isRecording={meetingState === "recording"}
          level={level}
          baseHeight={hovered ? 90 : 80}
          silentHeight={hovered ? 30 : 25}
        />
      ))}
    </div>
  );

  if (!hovered) {
    return (
      <motion.div
        key="recording-collapsed"
        data-hit-zone="true"
        initial={false}
        animate={{ width: 44, height: 44 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={`${PILL_SHELL_CLASS} flex items-center justify-center overflow-hidden rounded-full before:rounded-full`}
      >
        {waveformContent}
      </motion.div>
    );
  }

  const stopIcon = isBusy ? (
    <Loader2 className="size-5 animate-spin" />
  ) : isError ? (
    <AlertTriangle className="size-[18px] text-red-400" />
  ) : (
    <Square className="size-[11px] fill-current" />
  );

  const stopButton = (
    <IconButton
      tooltip="Stop Recording"
      icon={stopIcon}
      onClick={onStop}
      disabled={isBusy}
      destructive
    />
  );

  const waveformAsAnchor = (
    <div
      className={`${PILL_SHELL_CLASS} pointer-events-auto flex size-9 items-center justify-center rounded-full before:rounded-full`}
      data-hit-zone="true"
    >
      {waveformContent}
    </div>
  );

  const openNoteButton = (
    <IconButton
      tooltip="Open Note"
      icon={<IconNotes size={16} stroke={2} />}
      onClick={onOpenNote}
    />
  );

  return (
    <IconButtonStack
      edge={edge}
      secondaryLeading={stopButton}
      mainAnchor={waveformAsAnchor}
      secondaryTrailing={openNoteButton}
    />
  );
}
