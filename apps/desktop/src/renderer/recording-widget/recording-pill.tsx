import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Waveform } from "@/components/Waveform";
import { StopButton, NotesIconButton } from "./widget-buttons";
import { PILL_SHELL_CLASS } from "./idle-pill";
import type { MeetingRuntimeState } from "@/types/meeting";

const NUM_WAVEFORM_BARS_HOVERED = 6;
const NUM_WAVEFORM_BARS_COLLAPSED = 4;

export interface RecordingPillProps {
  hovered: boolean;
  meetingState: MeetingRuntimeState;
  // Real-time amplitude (0-1) — combined mic + system, owned by the parent.
  level: number;
  onStop: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onOpenNote: () => void;
}

export function RecordingPill({
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

  return (
    <motion.div
      key="recording"
      data-hit-zone="true"
      initial={false}
      animate={hovered ? { height: 48, width: 137 } : { height: 44, width: 44 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={`${PILL_SHELL_CLASS} flex items-center justify-center overflow-hidden rounded-full before:rounded-full ${hovered ? "gap-[10px]" : ""}`}
    >
      <AnimatePresence>
        {hovered && (
          <motion.div
            key="stop"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.14 }}
          >
            {isBusy ? (
              <span className="flex size-8 items-center justify-center text-white/80">
                <Loader2 className="size-5 animate-spin" />
              </span>
            ) : isError ? (
              <span className="flex size-8 items-center justify-center text-red-400">
                <AlertTriangle className="size-[18px]" />
              </span>
            ) : (
              <StopButton onClick={onStop} disabled={isBusy} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

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

      <AnimatePresence>
        {hovered && (
          <motion.div
            key="open-note"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.14 }}
          >
            <NotesIconButton onClick={onOpenNote} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
