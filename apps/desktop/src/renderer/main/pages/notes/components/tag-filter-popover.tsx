import * as React from "react";
import { Star, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";
import { TagRowMenu } from "@/renderer/main/components/tag/tag-row-menu";
import { TagEditDialog } from "@/renderer/main/components/tag/tag-edit-dialog";
import { api } from "@/trpc/react";
import type { Tag } from "@/db/schema";

type Props = {
  trigger: React.ReactNode;
  selectedTagIds: number[];
  onToggle: (tagId: number) => void;
};

export function TagFilterPopover({
  trigger,
  selectedTagIds,
  onToggle,
}: Props) {
  const { t } = useTranslation();
  const utils = api.useUtils();

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [editing, setEditing] = React.useState<Tag | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<Tag | null>(
    null,
  );

  const tagsQuery = api.tags.listWithCounts.useQuery({ sortBy: "name" });

  const createTag = api.tags.create.useMutation({
    onSuccess: (created) => {
      utils.tags.invalidate();
      onToggle(created.id);
      setSearch("");
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.createFailed", { message: error.message }),
      );
    },
  });

  const deleteTag = api.tags.delete.useMutation({
    onSuccess: (_result, variables) => {
      const deleted = (tagsQuery.data ?? []).find((r) => r.id === variables.id);
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      setConfirmingDelete(null);
      if (deleted) {
        toast.success(t("settings.tags.toast.deleted", { name: deleted.name }));
      }
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.deleteFailed", { message: error.message }),
      );
    },
  });

  const allTags = tagsQuery.data ?? [];

  const filtered = React.useMemo(() => {
    if (!search.trim()) return allTags;
    const lower = search.toLowerCase();
    return allTags.filter((t) => t.name.toLowerCase().includes(lower));
  }, [allTags, search]);

  const showCreateFooter =
    search.trim().length > 0 &&
    !filtered.some(
      (tag) => tag.name.toLowerCase() === search.trim().toLowerCase(),
    );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("settings.tags.searchPlaceholder")}
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>{t("settings.tags.empty")}</CommandEmpty>
              {filtered.map((tag) => {
                const isSelected = selectedTagIds.includes(tag.id);
                return (
                  <CommandItem
                    key={tag.id}
                    value={tag.id.toString()}
                    onSelect={() => onToggle(tag.id)}
                    className="group/item flex items-center gap-2 px-2 py-1.5"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      className="size-3 shrink-0 rounded"
                      aria-hidden="true"
                    />
                    <TagHash
                      color={tag.color}
                      name={tag.name}
                      className="min-w-0 flex-1"
                    />
                    {tag.isFavorite && (
                      <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                    )}
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {t("settings.tags.noteCount", { count: tag.noteCount })}
                    </span>
                    <span
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="shrink-0"
                    >
                      <TagRowMenu
                        tag={tag}
                        onEdit={() => setEditing(tag)}
                        onDelete={() => setConfirmingDelete(tag)}
                        triggerClassName="inline-flex aspect-square w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 outline-hidden transition-opacity hover:bg-muted group-data-[selected=true]/item:opacity-100 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                      />
                    </span>
                  </CommandItem>
                );
              })}
              {showCreateFooter && (
                <CommandItem
                  value={`__create__${search}`}
                  onSelect={() => {
                    if (!createTag.isPending) {
                      createTag.mutate({ name: search.trim() });
                    }
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 text-sm"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    {t("settings.tags.create", { name: search.trim() })}
                  </span>
                </CommandItem>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {editing && (
        <TagEditDialog
          tag={editing}
          noteCount={
            allTags.find((r) => r.id === editing.id)?.noteCount ?? 0
          }
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}

      <AlertDialog
        open={confirmingDelete !== null}
        onOpenChange={(o) => !o && setConfirmingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tags.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tags.deleteConfirmDescription", {
                count: confirmingDelete
                  ? (allTags.find((r) => r.id === confirmingDelete.id)
                      ?.noteCount ?? 0)
                  : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmingDelete &&
                deleteTag.mutate({ id: confirmingDelete.id })
              }
              className="bg-destructive text-foreground hover:bg-destructive/90"
            >
              {t("settings.tags.menu.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
