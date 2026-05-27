import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Loader2, Square } from "lucide-react";
import { Waveform } from "@/components/Waveform";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MeetingRuntimeState } from "@/types/meeting";
import { PILL_SHELL_CLASS } from "./idle-pill";

const NUM_WAVEFORM_BARS = 4;

export interface WaveformStopAnchorProps {
  meetingState: MeetingRuntimeState;
  level: number;
  onStop: (event: React.MouseEvent<HTMLButtonElement>) => void;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

export function WaveformStopAnchor({
  meetingState,
  level,
  onStop,
  tooltipSide = "left",
}: WaveformStopAnchorProps) {
  const [isInnerHover, setIsInnerHover] = useState(false);

  const isError = meetingState === "error";
  const isStarting = meetingState === "starting";
  const isStopping = meetingState === "stopping";
  const isBusy = isStarting || isStopping;
  const showStop = isInnerHover && !isBusy && !isError;

  const button = (
    <button
      type="button"
      data-hit-zone="true"
      aria-label="Stop Recording"
      onClick={onStop}
      onMouseEnter={() => setIsInnerHover(true)}
      onMouseLeave={() => setIsInnerHover(false)}
      disabled={isBusy}
      className={[
        "pointer-events-auto flex size-9 items-center justify-center rounded-full",
        "border border-white/15 bg-black/80 backdrop-blur-md",
        "shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
        "transition-colors",
        // Stop-hover state: fully opaque black + bright border so it pops
        // on light wallpapers and reads clearly as "destructive on hover".
        showStop
          ? "text-red-400 border-white/55 bg-black"
          : "text-white/85",
        "disabled:cursor-not-allowed disabled:opacity-60",
        PILL_SHELL_CLASS,
        "before:rounded-full",
      ].join(" ")}
    >
      <AnimatePresence mode="wait" initial={false}>
        {isBusy ? (
          <motion.span
            key="busy"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <Loader2 className="size-5 animate-spin" />
          </motion.span>
        ) : isError ? (
          <motion.span
            key="error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <AlertTriangle className="size-[18px]" />
          </motion.span>
        ) : showStop ? (
          <motion.span
            key="stop"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.12 }}
            className="flex items-center justify-center"
          >
            <Square className="size-[11px] fill-current" />
          </motion.span>
        ) : (
          <motion.div
            key="wave"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="flex h-[18px] flex-none items-center justify-center gap-[2.5px]"
          >
            {Array.from({ length: NUM_WAVEFORM_BARS }).map((_, index) => (
              <Waveform
                key={index}
                index={index}
                isRecording={meetingState === "recording"}
                level={level}
                baseHeight={90}
                silentHeight={30}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={6}>
        Stop Recording
      </TooltipContent>
    </Tooltip>
  );
}
