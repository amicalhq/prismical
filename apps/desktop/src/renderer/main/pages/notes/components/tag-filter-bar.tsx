import * as React from "react";
import { Plus, Settings2, Star } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
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
  ComboboxSeparator,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox-radix";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";
import { api } from "@/trpc/react";
import { ManageTagsDialog } from "./manage-tags-dialog";

const TAG_NAME_RE = /^[a-z0-9_-]{1,32}$/;

// Cap visible chips so the bar doesn't sprawl. Hidden chips remain selected
// — users see/manage them via the dropdown (each row checks when selected).
const MAX_VISIBLE_CHIPS = 2;

// Sentinel values for non-tag actions inside the combobox list. They're
// strings cast to satisfy the Combobox<number, true> generic — see comments
// at each call site.
const MANAGE_VALUE = "__manage_tags__";

/**
 * Tag filter for the /notes browser. Renders an integrated chip-input
 * combobox: selected tags appear as removable chips inline with the
 * typeahead, and clicking the input opens a dropdown of all tags.
 *
 * Per-tag management (rename / favorite / delete) lives in a separate
 * "Manage tags" dialog reachable from the dropdown footer — keeping the
 * picker rows clean and avoiding click-bubbling issues with menus inside
 * combobox items.
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
  const [manageOpen, setManageOpen] = React.useState(false);

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
      setTags([...selectedIds, created.id]);
      setQuery("");
    },
    onError: (e) =>
      toast.error(
        t("settings.tags.errors.createFailed", { message: e.message }),
      ),
  });

  // Picking a tag normally fires onValueChange with the new array. The
  // create / manage rows aren't real tag values; we intercept them here
  // and reset their state-leak before the array roundtrip lands.
  const handleValueChange = (next: unknown) => {
    const ids = (next as Array<number | string>) ?? [];
    // If the manage sentinel was added by a click, swallow it and open
    // the dialog instead — never write it into the URL.
    if (ids.includes(MANAGE_VALUE)) {
      setManageOpen(true);
      // Drop both sentinels to keep selection clean.
      setTags(ids.filter((v): v is number => typeof v === "number"));
      return;
    }
    // If a "__create_<name>" sentinel was added, fire createTag and
    // strip the sentinel — the new id is added in createTag.onSuccess.
    if (ids.some((v) => typeof v === "string" && v.startsWith("__create_"))) {
      if (showCreate && !createTag.isPending) {
        createTag.mutate({ name: lc });
      }
      setTags(ids.filter((v): v is number => typeof v === "number"));
      return;
    }
    setTags(ids as number[]);
  };

  return (
    <>
      <Combobox<number, true>
        multiple
        value={selectedIds}
        onValueChange={handleValueChange}
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
                className="flex items-center gap-2"
              >
                <TagHash color={tag.color} name={tag.name} className="flex-1" />
                {tag.isFavorite && (
                  <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                )}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {tag.noteCount}
                </span>
              </ComboboxItem>
            ))}

            {showCreate && (
              <ComboboxItem
                // Cast: Combobox is generic over number, but this row's
                // value is a string sentinel intercepted in handleValueChange.
                value={`__create_${lc}` as unknown as number}
                className="text-muted-foreground"
              >
                <Plus className="h-4 w-4" />
                <Trans
                  i18nKey="settings.tags.create"
                  values={{ name: lc }}
                  components={{ 1: <strong /> }}
                />
              </ComboboxItem>
            )}

            <ComboboxSeparator />

            <ComboboxItem
              // Cast: same reason — sentinel intercepted in handleValueChange.
              value={MANAGE_VALUE as unknown as number}
              className="text-muted-foreground"
            >
              <Settings2 className="h-4 w-4" />
              <span>{t("settings.tags.filterBar.manage")}</span>
            </ComboboxItem>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      <ManageTagsDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  );
}
