import { motion } from "framer-motion";
import type { ReactNode } from "react";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";

export interface IconButtonStackProps {
  edge: MeetingWidgetEdge;
  /** Element that's always visible (collapsed and expanded). */
  mainAnchor: ReactNode;
  /** Secondary slot that visually flips position with edge rotation. */
  secondaryLeading?: ReactNode;
  /** Optional second secondary on the opposite side of main-anchor. */
  secondaryTrailing?: ReactNode;
}

export function IconButtonStack({
  edge,
  mainAnchor,
  secondaryLeading,
  secondaryTrailing,
}: IconButtonStackProps) {
  if (edge === "right") {
    return (
      <motion.div layout className="flex flex-col items-center gap-1.5">
        {secondaryLeading}
        {mainAnchor}
        {secondaryTrailing}
      </motion.div>
    );
  }
  // edge === "bottom" — rotate 90° CW: top→right, bottom→left.
  return (
    <motion.div layout className="flex flex-row items-center gap-1.5">
      {secondaryTrailing}
      {mainAnchor}
      {secondaryLeading}
    </motion.div>
  );
}
