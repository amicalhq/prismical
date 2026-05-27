import { motion } from "framer-motion";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";

export interface DragHandleProps {
  edge: MeetingWidgetEdge;
  visible: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

export function DragHandle({ edge, visible, onPointerDown }: DragHandleProps) {
  const isVertical = edge === "right";
  return (
    <motion.button
      type="button"
      data-hit-zone={visible ? "true" : undefined}
      onPointerDown={onPointerDown}
      initial={false}
      animate={{
        opacity: visible ? 1 : 0,
        scale: visible ? 1 : 0.85,
      }}
      transition={{ type: "spring", stiffness: 480, damping: 28 }}
      style={{ pointerEvents: visible ? "auto" : "none" }}
      className={`flex ${
        isVertical ? "h-[18px] w-[28px]" : "h-[28px] w-[18px]"
      } items-center justify-center rounded-full border border-white/10 bg-[rgba(12,14,18,0.72)] text-white/45 backdrop-blur-md shadow-[0_8px_20px_rgba(3,6,14,0.28)]`}
      aria-label="Drag recording widget"
    >
      <div
        className={`grid ${
          isVertical ? "grid-cols-3 grid-rows-2" : "grid-cols-2 grid-rows-3"
        } gap-[2.5px]`}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="h-[2.5px] w-[2.5px] rounded-full bg-current" />
        ))}
      </div>
    </motion.button>
  );
}
