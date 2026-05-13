import { useEffect, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
} from "lexical";
import { api } from "@/trpc/react";
import { useRunSkill } from "@/renderer/main/hooks/use-run-skill";
import type { SerializedSelectionPoints } from "@/renderer/main/components/editor/diff/skill-diff-store";

interface Props {
  noteId: number;
}

interface PopoverState {
  top: number;
  left: number;
  selectionText: string;
  selectionPoints: SerializedSelectionPoints;
}

// Width/height estimates for off-screen clamping. The popover content is short
// (skill name buttons) so a generous estimate keeps us inside the viewport
// without measuring the rendered element.
const POPOVER_ESTIMATED_HEIGHT = 40;
const POPOVER_ESTIMATED_WIDTH = 240;
const VIEWPORT_MARGIN = 8;

export function InlineSkillPopoverPlugin({ noteId }: Props) {
  const [editor] = useLexicalComposerContext();
  const { data: skills = [] } = api.skills.listForSurface.useQuery({
    surface: "inline",
  });
  // Hide the popover while a skill is already running on this note —
  // clicking an inline skill mid-run would otherwise surface a generic
  // "A skill is already running" error toast. Poll at a steady 1s so we
  // pick up runs initiated from other surfaces (sparkle button, etc.)
  // without depending on a race-prone optimistic invalidate.
  const { data: inFlight } = api.skillRuns.getInFlight.useQuery(
    { noteId },
    { refetchInterval: 1000 },
  );
  const { runSkill, isPending } = useRunSkill();
  const [popover, setPopover] = useState<PopoverState | null>(null);

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        editor.read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || sel.isCollapsed()) {
            setPopover(null);
            return;
          }
          const text = sel.getTextContent();
          if (!text.trim()) {
            setPopover(null);
            return;
          }
          const nativeSel = window.getSelection();
          if (!nativeSel || nativeSel.rangeCount === 0) {
            setPopover(null);
            return;
          }
          const rect = nativeSel.getRangeAt(0).getBoundingClientRect();
          // Capture selection anchor/focus so accept can restore the range
          // long after the user has clicked the action bar (Lexical's live
          // selection has moved by then).
          const selectionPoints: SerializedSelectionPoints = {
            anchor: {
              key: sel.anchor.key,
              offset: sel.anchor.offset,
              type: sel.anchor.type,
            },
            focus: {
              key: sel.focus.key,
              offset: sel.focus.offset,
              type: sel.focus.type,
            },
          };
          // Clamp position to viewport. Default anchors above the selection;
          // if there's no room, drop below.
          const viewportWidth = window.innerWidth;
          let top = rect.top - VIEWPORT_MARGIN - POPOVER_ESTIMATED_HEIGHT;
          if (top < VIEWPORT_MARGIN) {
            top = rect.bottom + VIEWPORT_MARGIN;
          }
          const left = Math.min(
            Math.max(VIEWPORT_MARGIN, rect.left),
            viewportWidth - POPOVER_ESTIMATED_WIDTH - VIEWPORT_MARGIN,
          );
          setPopover({ top, left, selectionText: text, selectionPoints });
        });
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  if (!popover || skills.length === 0 || inFlight || isPending) return null;

  return (
    <div
      className="fixed z-50 rounded-md border bg-popover shadow-lg p-1 flex items-center gap-1"
      style={{ top: popover.top, left: popover.left }}
    >
      {skills.map((s) => (
        <button
          key={s.id}
          className="px-2 py-1 text-xs rounded hover:bg-muted"
          onClick={() => {
            runSkill({
              noteId,
              skillSlug: s.slug,
              skillName: s.name,
              modeOverride: "inline-rewrite",
              selectionText: popover.selectionText,
              selectionPoints: popover.selectionPoints,
            });
            setPopover(null);
          }}
        >
          ✨ {s.name}
        </button>
      ))}
    </div>
  );
}
