import { motion } from "framer-motion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";

export interface DragHandleProps {
  edge: MeetingWidgetEdge;
  visible: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  /** Side the tooltip floats on; matches the sibling buttons. */
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

export function DragHandle({
  edge,
  visible,
  onPointerDown,
  tooltipSide = "left",
}: DragHandleProps) {
  const isVertical = edge === "right";

  const button = (
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
      className={[
        "flex items-center justify-center rounded-full border backdrop-blur-md",
        "shadow-[0_8px_20px_rgba(3,6,14,0.28)]",
        "transition-colors",
        // Match IconButton's hover language: opaque black + brighter
        // border and dots so the handle reads as "interactive on hover"
        // instead of disappearing into dark wallpapers.
        "border-white/10 bg-[rgba(12,14,18,0.72)] text-white/45",
        "hover:border-white/55 hover:bg-black hover:text-white",
        "cursor-grab active:cursor-grabbing",
        isVertical ? "h-[18px] w-[28px]" : "h-[28px] w-[18px]",
      ].join(" ")}
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={6}>
        Drag to move
      </TooltipContent>
    </Tooltip>
  );
}
