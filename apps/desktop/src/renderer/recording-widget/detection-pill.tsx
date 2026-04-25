import { motion } from "framer-motion";
import { X, Mic } from "lucide-react";
import { TakeNotesButton, OutlinedIconButton } from "./widget-buttons";
import { PILL_SHELL_CLASS } from "./idle-pill";
import type { MeetingStartNotificationPayload } from "@/types/meeting-start-notifications";

export interface DetectionPillProps {
  payload: MeetingStartNotificationPayload;
  onTakeNotes: () => void;
  onDismiss: () => void;
  takingNotes: boolean;
  dismissing: boolean;
}

export function DetectionPill({
  payload,
  onTakeNotes,
  onDismiss,
  takingNotes,
  dismissing,
}: DetectionPillProps) {
  const initial = (payload.displayName || "?").charAt(0).toUpperCase();
  // The current detection pipeline only fires for known meeting apps, so
  // `displayName` is always populated. We still render the unknown-app
  // fallback (mic glyph) defensively in case detection is later extended.
  const isKnown = !!payload.displayName && payload.displayName.length > 0;

  return (
    <motion.div
      key="detection"
      data-hit-zone="true"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={`${PILL_SHELL_CLASS} flex h-11 items-center gap-2.5 overflow-hidden rounded-full before:rounded-full pl-3 pr-1.5`}
    >
      <span
        className={`flex size-[22px] flex-none items-center justify-center rounded-md text-[11px] font-bold text-white ${isKnown ? "" : "bg-white/[0.10] text-white/70"}`}
        style={
          isKnown
            ? {
                background:
                  "linear-gradient(135deg, rgb(45,140,255), rgb(30,111,217))",
              }
            : undefined
        }
      >
        {isKnown ? initial : <Mic className="size-[13px]" />}
      </span>

      <span className="whitespace-nowrap text-[12px] font-medium text-white/90">
        Meeting Detected
      </span>

      <TakeNotesButton
        onClick={onTakeNotes}
        loading={takingNotes}
        disabled={takingNotes || dismissing}
      />

      <OutlinedIconButton
        onClick={onDismiss}
        disabled={takingNotes || dismissing}
        aria-label="Dismiss meeting detection"
      >
        <X className="size-[13px]" />
      </OutlinedIconButton>
    </motion.div>
  );
}
