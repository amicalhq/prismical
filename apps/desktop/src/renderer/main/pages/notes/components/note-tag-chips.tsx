import { useRef, useState } from "react";
import { Plus, Tag as TagIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { TagChip } from "@/renderer/main/components/tag/tag-chip";
import { TagPicker } from "@/renderer/main/components/tag/tag-picker";
import { api } from "@/trpc/react";

const VISIBLE_LIMIT = 3;

interface NoteTagChipsProps {
  noteId: number;
  isNarrow?: boolean;
}

export function NoteTagChips({ noteId, isNarrow }: NoteTagChipsProps) {
  const navigate = useNavigate();
  const utils = api.useUtils();
  const tagsQ = api.tags.getForNote.useQuery({ noteId });
  const detach = api.tags.detach.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
    },
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const tags = tagsQ.data ?? [];
  const visible = tags.slice(0, VISIBLE_LIMIT);
  const overflow = tags.length - visible.length;

  const goToTag = (tagId: number) =>
    navigate({ to: "/settings/notes", search: { tag: tagId } });

  const togglePicker = () => setPickerOpen((o) => !o);

  if (isNarrow) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePicker}
          className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed px-2 text-[11px] text-muted-foreground"
          aria-label="Tags"
        >
          <TagIcon className="h-3 w-3" />
          {tags.length}
        </button>
        <TagPicker
          noteId={noteId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          anchor={triggerRef}
        />
      </>
    );
  }

  if (tags.length === 0) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePicker}
          className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          tags
        </button>
        <TagPicker
          noteId={noteId}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          anchor={triggerRef}
        />
      </>
    );
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <TagChip
          key={t.id}
          name={t.name}
          color={t.color}
          onClick={() => goToTag(t.id)}
          onRemove={() => detach.mutate({ noteId, tagId: t.id })}
        />
      ))}
      {overflow > 0 && (
        <span
          className="inline-flex h-[22px] cursor-default items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground"
          title={tags
            .slice(VISIBLE_LIMIT)
            .map((t) => `#${t.name}`)
            .join(", ")}
        >
          +{overflow}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePicker}
        aria-label="Add tag"
        className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border border-dashed text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
      </button>
      <TagPicker
        noteId={noteId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        anchor={triggerRef}
      />
    </div>
  );
}
