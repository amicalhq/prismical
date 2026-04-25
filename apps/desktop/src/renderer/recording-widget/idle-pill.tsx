import { motion } from "framer-motion";
import { TakeNotesButton } from "./widget-buttons";

export const PILL_SHELL_CLASS =
  "relative pointer-events-auto bg-black/80 dark:bg-black/70 backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] before:content-[''] before:absolute before:inset-[1px] before:outline before:outline-white/15 before:pointer-events-none";

export interface IdlePillProps {
  hovered: boolean;
  onTakeNotes: () => void;
  takingNotes: boolean;
}

export function IdlePill({ hovered, onTakeNotes, takingNotes }: IdlePillProps) {
  return (
    <motion.div
      key="idle"
      data-hit-zone="true"
      initial={false}
      animate={hovered ? { width: 130, height: 44 } : { width: 8, height: 56 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={`${PILL_SHELL_CLASS} flex items-center justify-center overflow-hidden whitespace-nowrap rounded-full before:rounded-full`}
    >
      {hovered && (
        <motion.div
          key="take-notes"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12, delay: 0.08 }}
          className="flex items-center whitespace-nowrap"
        >
          <TakeNotesButton
            onClick={onTakeNotes}
            loading={takingNotes}
            disabled={takingNotes}
          />
        </motion.div>
      )}
    </motion.div>
  );
}
