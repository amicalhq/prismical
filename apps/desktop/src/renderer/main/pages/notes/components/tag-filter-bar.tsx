import * as React from "react";
import { Plus, Star } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";

// Cap visible chips so the bar doesn't sprawl when many tags are selected.
// Hidden chips remain selected — users see/manage them by opening the
// dropdown (each row shows a checkmark when selected).
const MAX_VISIBLE_CHIPS = 3;
import { toast } from "sonner";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox-radix";
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

const TAG_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Tag filter for the /notes browser. Renders an integrated chip-input
 * combobox: selected tags appear as removable chips inline with the
 * typeahead, and clicking the input opens a dropdown of all tags. Each
 * dropdown row also exposes a row-menu (rename / favorite / delete) so
 * the picker doubles as the management surface for tags.
 *
 * Selection is owned by the URL `?tags=` search param.
 */
export function TagFilterBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const anchor = useComboboxAnchor();

  const search = useSearch({ strict: false }) as { tags?: number[] };
  const selectedIds = React.useMemo(() => search.tags ?? [], [search.tags]);

  const tagsQ = api.tags.listWithCounts.useQuery({ sortBy: "name" });
  const tagById = React.useMemo(
    () => new Map((tagsQ.data ?? []).map((tag) => [tag.id, tag])),
    [tagsQ.data],
  );

  const setTags = (ids: number[]) => {
    navigate({
      to: "/notes",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        tags: ids.length > 0 ? ids : undefined,
      })) as never,
    });
  };

  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<Tag | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState<Tag | null>(
    null,
  );

  const lc = query.trim().toLowerCase();
  const all = tagsQ.data ?? [];
  const filtered = lc
    ? all.filter((tag) => tag.name.toLowerCase().includes(lc))
    : all;
  const exact = all.find((tag) => tag.name.toLowerCase() === lc);
  const showCreate = lc.length > 0 && TAG_NAME_RE.test(lc) && !exact;

  const createTag = api.tags.create.useMutation({
    onSuccess: (created) => {
      utils.tags.invalidate();
      // Add the newly created tag to the active filter selection.
      setTags([...selectedIds, created.id]);
      setQuery("");
    },
    onError: (e) =>
      toast.error(
        t("settings.tags.errors.createFailed", { message: e.message }),
      ),
  });

  const deleteTag = api.tags.delete.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      // If the deleted tag was in the active filter, drop it.
      if (confirmingDelete) {
        setTags(selectedIds.filter((id) => id !== confirmingDelete.id));
      }
      setConfirmingDelete(null);
    },
    onError: (e) =>
      toast.error(
        t("settings.tags.errors.deleteFailed", { message: e.message }),
      ),
  });

  const handleCreate = () => {
    if (!showCreate || createTag.isPending) return;
    createTag.mutate({ name: lc });
  };

  return (
    <>
      <Combobox<number, true>
        multiple
        value={selectedIds}
        onValueChange={setTags}
        inputValue={query}
        onInputValueChange={setQuery}
        filter={null}
      >
        <ComboboxChips
          ref={anchor}
          className="h-9 w-56 flex-nowrap overflow-hidden rounded-lg border-transparent bg-accent/40 px-2 hover:bg-accent/60 dark:bg-accent/30 dark:hover:bg-accent/50"
        >
          <ComboboxValue>
            {(values) => {
              const ids = (values as number[]) ?? [];
              const visible = ids.slice(0, MAX_VISIBLE_CHIPS);
              const overflow = ids.length - visible.length;
              return (
                <>
                  {visible.map((id) => {
                    const tag = tagById.get(id);
                    return (
                      <ComboboxChip
                        key={id}
                        className="bg-transparent px-2"
                        style={
                          tag
                            ? {
                                backgroundColor: `${tag.color}26`,
                                color: tag.color,
                              }
                            : undefined
                        }
                      >
                        {tag ? (
                          <TagHash color={tag.color} name={tag.name} />
                        ) : (
                          <span className="text-muted-foreground">#…</span>
                        )}
                      </ComboboxChip>
                    );
                  })}
                  {overflow > 0 && (
                    <span
                      className="shrink-0 px-1 text-xs text-muted-foreground"
                      aria-label={t("settings.tags.filterBar.overflow", {
                        count: overflow,
                      })}
                    >
                      +{overflow}
                    </span>
                  )}
                  <ComboboxChipsInput
                    placeholder={
                      ids.length === 0
                        ? t("settings.tags.filterBar.placeholder")
                        : ""
                    }
                    className="min-w-12"
                  />
                </>
              );
            }}
          </ComboboxValue>
        </ComboboxChips>

        <ComboboxContent anchor={anchor} className="w-72">
          <ComboboxList>
            {filtered.length === 0 && !showCreate && (
              <ComboboxEmpty>{t("settings.tags.empty")}</ComboboxEmpty>
            )}

            {filtered.map((tag) => (
              <ComboboxItem
                key={tag.id}
                value={tag.id}
                className="group flex items-center gap-2"
              >
                <TagHash color={tag.color} name={tag.name} className="flex-1" />
                {tag.isFavorite && (
                  <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {tag.noteCount}
                </span>
                <span
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="shrink-0"
                >
                  <TagRowMenu
                    tag={tag}
                    onEdit={() => setEditing(tag)}
                    onDelete={() => setConfirmingDelete(tag)}
                    triggerClassName="ml-0.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent/60 group-hover:opacity-100 data-[state=open]:opacity-100"
                  />
                </span>
              </ComboboxItem>
            ))}

            {showCreate && (
              <ComboboxItem
                value={`__create_${lc}` as unknown as number}
                onClick={handleCreate}
                className="border-t border-border text-muted-foreground"
              >
                <Plus className="h-4 w-4" />
                <Trans
                  i18nKey="settings.tags.create"
                  values={{ name: lc }}
                  components={{ 1: <strong /> }}
                />
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      {editing && (
        <TagEditDialog
          tag={editing}
          noteCount={tagById.get(editing.id)?.noteCount ?? 0}
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
                  ? (tagById.get(confirmingDelete.id)?.noteCount ?? 0)
                  : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmingDelete) {
                  deleteTag.mutate({ id: confirmingDelete.id });
                }
              }}
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
