import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { api } from "@/trpc/react";
import { useRunSkill } from "@/renderer/main/hooks/use-run-skill";
import type { SerializedSelectionPoints } from "@/renderer/main/components/editor/diff/skill-diff-store";

interface Props {
  editor: Editor;
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

export function InlineSkillPopoverPlugin({ editor, noteId }: Props) {
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
    const onSelectionUpdate = ({ editor: ed }: { editor: Editor }) => {
      const { state } = ed;
      const { from, to, empty } = state.selection;
      if (empty) {
        setPopover(null);
        return;
      }
      const text = state.doc.textBetween(from, to, " ");
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
      // Capture from/to so accept can restore the range long after the
      // user has clicked the action bar (the editor's live selection has
      // moved by then).
      const selectionPoints: SerializedSelectionPoints = { from, to };
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
    };

    editor.on("selectionUpdate", onSelectionUpdate);
    editor.on("blur", () => setPopover(null));

    return () => {
      editor.off("selectionUpdate", onSelectionUpdate);
    };
  }, [editor]);

  if (!popover || skills.length === 0 || inFlight || isPending) return null;

  return (
    <div
      className="fixed z-50 rounded-md bg-primary text-primary-foreground shadow-lg p-1 flex items-center gap-1"
      style={{ top: popover.top, left: popover.left }}
    >
      {skills.map((s) => (
        <button
          key={s.id}
          className="px-2 py-1 text-xs rounded hover:bg-primary-foreground/10"
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
