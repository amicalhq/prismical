import { AnimatePresence, motion } from "framer-motion";
import { Mic } from "lucide-react";
import { IconNotes } from "@tabler/icons-react";
import type { MeetingWidgetEdge } from "@/types/meeting-widget";
import { IconButton } from "./icon-button";
import { DragHandle } from "./drag-handle";

export const PILL_SHELL_CLASS =
  "relative pointer-events-auto bg-black/80 dark:bg-black/70 backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] before:content-[''] before:absolute before:inset-[1px] before:outline before:outline-white/15 before:pointer-events-none";

export interface IdlePillProps {
  edge: MeetingWidgetEdge;
  hovered: boolean;
  onTakeNotes: () => void;
  takingNotes: boolean;
  onStartRecording: () => void;
  startingRecording: boolean;
  showHandle: boolean;
  onDragStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

// Frame = the 36×36 Mic-slot. Sliver and Mic occupy this exact spot, so
// the bar morphs in place with no displacement. Take Notes and the drag
// handle are absolutely positioned around the frame and fade/scale in
// when hovered, without affecting layout.
const FRAME = 36;
const GAP = 6;
const TAKE_NOTES = 36;
const HANDLE_SHORT = 18;

const anchorSpring = {
  type: "spring",
  stiffness: 420,
  damping: 32,
} as const;

const popSpring = {
  type: "spring",
  stiffness: 460,
  damping: 28,
} as const;

export function IdlePill({
  edge,
  hovered,
  onTakeNotes,
  takingNotes,
  onStartRecording,
  startingRecording,
  showHandle,
  onDragStart,
}: IdlePillProps) {
  const isVertical = edge === "right";
  const tooltipSide = isVertical ? "left" : "top";

  // Sliver and Mic share the frame's center. Sliver may exceed the
  // 36×36 box on one axis; absolute positioning lets it overflow visually
  // without affecting layout.
  const sliverDims = isVertical
    ? { width: 8, height: 56 }
    : { width: 56, height: 8 };
  const micDims = { width: FRAME, height: FRAME };

  // Where Take Notes lives relative to the frame.
  const takeNotesStyle = isVertical
    ? { right: 0, top: -(TAKE_NOTES + GAP) }
    : { right: -(TAKE_NOTES + GAP), top: 0 };
  const takeNotesEnter = isVertical ? { y: 14 } : { x: -14 };

  // Where the drag handle lives relative to the frame — opposite side
  // from Take Notes so they don't overlap (right-edge: handle below,
  // bottom-edge: handle to the left while Take Notes is to the right).
  const handleStyle: React.CSSProperties = isVertical
    ? {
        bottom: -(HANDLE_SHORT + GAP),
        left: "50%",
        transform: "translateX(-50%)",
      }
    : {
        left: -(HANDLE_SHORT + GAP),
        top: "50%",
        transform: "translateY(-50%)",
      };

  // Invisible hit-zone underlay covering the full expanded bounding
  // box (Take Notes + frame + drag handle + the gaps in-between). Buttons
  // and the sliver sit on top of it, so it only catches mousemove events
  // when the cursor is in a gap — which is enough to keep `isHovered`
  // true while the user travels between buttons.
  const hitUnderlayStyle: React.CSSProperties = isVertical
    ? {
        top: -(TAKE_NOTES + GAP),
        left: 0,
        width: FRAME,
        height: TAKE_NOTES + GAP + FRAME + GAP + HANDLE_SHORT,
      }
    : {
        top: 0,
        left: -(HANDLE_SHORT + GAP),
        width: HANDLE_SHORT + GAP + FRAME + GAP + TAKE_NOTES,
        height: FRAME,
      };

  // Pin the anchor (bar / Mic) to the screen-facing edge of the frame so
  // the bar's edge stays put while it morphs inward. The wrapper owns the
  // CSS transform that handles the perpendicular centering; the inner
  // motion element owns the size + opacity + scale animation, so the two
  // don't fight over the transform property.
  const anchorWrapperStyle: React.CSSProperties = isVertical
    ? { right: 0, top: "50%", transform: "translateY(-50%)" }
    : { bottom: 0, left: "50%", transform: "translateX(-50%)" };
  const micOrigin = isVertical ? "right center" : "center bottom";

  return (
    <div
      className="relative"
      style={{ width: FRAME, height: FRAME }}
      data-hit-zone={hovered ? "true" : undefined}
    >
      {/* Hit-zone underlay — only active while hovered. Keeps the cursor
          "inside" the widget as it travels across button gaps so the pill
          doesn't collapse mid-traversal. */}
      <div
        className="absolute"
        style={hitUnderlayStyle}
        data-hit-zone={hovered ? "true" : undefined}
      />

      {/* Sliver shell — bar at rest; morphs into the Mic's bounding box
          and fades out as the Mic IconButton fades in. Pinned to the
          screen-facing edge so the bar never moves away from it. */}
      <div className="absolute" style={anchorWrapperStyle}>
        <motion.div
          data-hit-zone="true"
          animate={
            hovered
              ? { ...micDims, opacity: 0 }
              : { ...sliverDims, opacity: 1 }
          }
          transition={anchorSpring}
          // Override PILL_SHELL_CLASS's dark ring with a white-tinted one
          // so the bar stays visible on dark wallpapers.
          className={`${PILL_SHELL_CLASS} ring-white/40 rounded-full before:rounded-full`}
        />
      </div>

      {/* Mic IconButton — same anchor as the bar, scales out from the
          screen edge to feel like the bar morphing into a button. */}
      <div
        className="absolute"
        style={{
          ...anchorWrapperStyle,
          pointerEvents: hovered ? "auto" : "none",
        }}
      >
        <motion.div
          initial={false}
          animate={{
            opacity: hovered ? 1 : 0,
            scale: hovered ? 1 : 0.6,
          }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          style={{ transformOrigin: micOrigin }}
        >
          <IconButton
            tooltip="Start Recording"
            icon={<Mic className="h-[18px] w-[18px]" />}
            onClick={onStartRecording}
            disabled={startingRecording}
            tooltipSide={tooltipSide}
          />
        </motion.div>
      </div>

      {/* Take Notes — absolute, outside the frame on the away-from-edge
          side. Slides toward the anchor on exit. */}
      <AnimatePresence>
        {hovered ? (
          <motion.div
            key="take-notes"
            initial={{ opacity: 0, scale: 0.4, ...takeNotesEnter }}
            animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, scale: 0.4, ...takeNotesEnter }}
            transition={popSpring}
            className="absolute"
            style={takeNotesStyle}
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

      {/* Drag handle — opposite side of Take Notes, follows hover state. */}
      <div className="absolute" style={handleStyle}>
        <DragHandle edge={edge} visible={showHandle} onPointerDown={onDragStart} />
      </div>
    </div>
  );
}
