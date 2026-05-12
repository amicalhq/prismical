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

interface Props {
  noteId: number;
}

export function InlineSkillPopoverPlugin({ noteId }: Props) {
  const [editor] = useLexicalComposerContext();
  const { data: skills = [] } = api.skills.listForSurface.useQuery({
    surface: "inline",
  });
  const { runSkill } = useRunSkill();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [selectionText, setSelectionText] = useState("");

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        editor.read(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel) || sel.isCollapsed()) {
            setPosition(null);
            return;
          }
          const text = sel.getTextContent();
          if (!text.trim()) {
            setPosition(null);
            return;
          }
          // Anchor: use the browser's getBoundingClientRect on the native selection.
          const nativeSel = window.getSelection();
          if (!nativeSel || nativeSel.rangeCount === 0) {
            setPosition(null);
            return;
          }
          const rect = nativeSel.getRangeAt(0).getBoundingClientRect();
          setSelectionText(text);
          setPosition({ top: rect.top - 8, left: rect.left });
        });
        return false; // don't intercept
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor]);

  if (!position || skills.length === 0) return null;

  return (
    <div
      className="fixed z-50 -translate-y-full rounded-md border bg-popover shadow-lg p-1 flex items-center gap-1"
      style={{ top: position.top, left: position.left }}
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
              selectionText,
            });
            setPosition(null);
          }}
        >
          ✨ {s.name}
        </button>
      ))}
    </div>
  );
}
