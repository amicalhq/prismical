import { AnimatePresence, motion } from "framer-motion";
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

const buttonSpring = {
  type: "spring",
  stiffness: 480,
  damping: 28,
} as const;

export function IdlePill({
  edge,
  hovered,
  onTakeNotes,
  takingNotes,
  onStartRecording,
  startingRecording,
}: IdlePillProps) {
  const sliver = edge === "right" ? SLIVER_RIGHT : SLIVER_BOTTOM;
  const tooltipSide = edge === "right" ? "left" : "top";

  // IconButtonStack's outer motion.div has `layout`, so the bounding box
  // animates as the sliver gives way to two buttons. Each slot uses
  // AnimatePresence so the sliver and the buttons fade/scale in & out
  // rather than crossfading abruptly — the effect is the bar morphing
  // outward into the buttons.
  return (
    <IconButtonStack
      edge={edge}
      secondaryLeading={
        <AnimatePresence initial={false}>
          {hovered ? (
            <motion.div
              key="take-notes"
              initial={{ opacity: 0, scale: 0.3 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.3 }}
              transition={buttonSpring}
            >
              <IconButton
                tooltip="Take Notes"
                icon={<IconNotes size={16} stroke={2} />}
                onClick={onTakeNotes}
                disabled={takingNotes}
                tooltipSide={tooltipSide}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      }
      mainAnchor={
        <AnimatePresence mode="popLayout" initial={false}>
          {hovered ? (
            <motion.div
              key="mic"
              initial={{ opacity: 0, scale: 0.3 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.3 }}
              transition={buttonSpring}
            >
              <IconButton
                tooltip="Start Recording"
                icon={<Mic className="h-[18px] w-[18px]" />}
                onClick={onStartRecording}
                disabled={startingRecording}
                tooltipSide={tooltipSide}
              />
            </motion.div>
          ) : (
            <motion.div
              key="sliver"
              data-hit-zone="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, ...sliver }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className={`${PILL_SHELL_CLASS} rounded-full before:rounded-full`}
            />
          )}
        </AnimatePresence>
      }
    />
  );
}
