import { useRef, useState } from "react";
import { Plus, Tag as TagIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TagChip } from "@/renderer/main/components/tag/tag-chip";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";
import { TagPicker } from "@/renderer/main/components/tag/tag-picker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/trpc/react";

const VISIBLE_LIMIT = 3;

interface NoteTagChipsProps {
  noteId: number;
  isNarrow?: boolean;
}

export function NoteTagChips({ noteId, isNarrow }: NoteTagChipsProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const utils = api.useUtils();
  const tagsQ = api.tags.getForNote.useQuery({ noteId });
  const detach = api.tags.detach.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.detachFailed", { message: error.message }),
      );
    },
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const tags = tagsQ.data ?? [];
  const visible = tags.slice(0, VISIBLE_LIMIT);
  const overflow = tags.length - visible.length;

  const goToTag = (tagId: number) =>
    navigate({ to: "/notes", search: { tags: [tagId] } });

  const togglePicker = () => setPickerOpen((o) => !o);

  if (isNarrow) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePicker}
          className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed px-2 text-[11px] text-muted-foreground"
          aria-label={t("settings.notes.note.actions.tagsLabel")}
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
          aria-label={t("settings.notes.note.actions.addTags")}
          className="inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed px-2 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("settings.notes.note.actions.addTags")}
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
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-[22px] cursor-default items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
              +{overflow}
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            <div className="flex flex-wrap items-center gap-1">
              {tags.slice(VISIBLE_LIMIT).map((tag) => (
                <TagHash key={tag.id} color={tag.color} name={tag.name} />
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePicker}
        aria-label={t("settings.notes.note.actions.addTags")}
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
