import { motion } from "framer-motion";
import { Mic } from "lucide-react";
import { IconNotes } from "@tabler/icons-react";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";
import { IconButton } from "./icon-button";
import { IconButtonStack } from "./icon-button-stack";

export const PILL_SHELL_CLASS =
  "relative pointer-events-auto bg-black/80 dark:bg-black/70 backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] before:content-[''] before:absolute before:inset-[1px] before:outline before:outline-white/15 before:pointer-events-none";

export interface IdlePillProps {
  edge: MeetingWidgetEdge;
  hovered: boolean;
  onTakeNotes: () => void;
  takingNotes: boolean;
  onStartRecording: () => void;
  startingRecording: boolean;
}

const SLIVER_RIGHT = { width: 8, height: 56 };
const SLIVER_BOTTOM = { width: 56, height: 8 };

export function IdlePill({
  edge,
  hovered,
  onTakeNotes,
  takingNotes,
  onStartRecording,
  startingRecording,
}: IdlePillProps) {
  if (hovered) {
    return (
      <IconButtonStack
        edge={edge}
        secondaryLeading={
          <IconButton
            tooltip="Take Notes"
            icon={<IconNotes size={16} stroke={2} />}
            onClick={onTakeNotes}
            disabled={takingNotes}
          />
        }
        mainAnchor={
          <IconButton
            tooltip="Start Recording"
            icon={<Mic className="h-[18px] w-[18px]" />}
            onClick={onStartRecording}
            disabled={startingRecording}
          />
        }
      />
    );
  }
  const sliver = edge === "right" ? SLIVER_RIGHT : SLIVER_BOTTOM;
  return (
    <motion.div
      key="idle-sliver"
      data-hit-zone="true"
      initial={false}
      animate={sliver}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={`${PILL_SHELL_CLASS} rounded-full before:rounded-full`}
    />
  );
}

// Note: PILL_SHELL_CLASS is also imported by recording-pill.tsx; keep the export.
