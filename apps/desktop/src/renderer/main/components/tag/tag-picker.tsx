import * as React from "react";
import { Check } from "lucide-react";

import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox-radix";
import { api } from "@/trpc/react";
import { TagHash } from "./tag-hash";

export interface TagPickerProps {
  noteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Optional anchor / trigger that the parent renders inside the Combobox root.
   * Typically the parent wraps `<TagPicker>` inside its own popover frame and
   * leaves this undefined; the prop is here for future flexibility.
   */
  trigger?: React.ReactNode;
}

/**
 * Multi-select tag combobox + create-on-the-fly footer.
 *
 * The component is fully controlled by the parent (`open` / `onOpenChange`).
 * Selecting any item toggles attach/detach for the given note; the "Create
 * #<query>" footer is shown when the lowercased query has no exact match and
 * runs `tags.create` then `tags.attach`.
 */
export function TagPicker({
  noteId,
  open,
  onOpenChange,
  trigger,
}: TagPickerProps) {
  const utils = api.useUtils();
  const [query, setQuery] = React.useState("");

  const allTags = api.tags.list.useQuery({ sortBy: "name" });
  const recentTags = api.tags.listRecent.useQuery({ limit: 5 });
  const noteTags = api.tags.getForNote.useQuery({ noteId });

  const attached = React.useMemo(
    () => new Set((noteTags.data ?? []).map((t) => t.id)),
    [noteTags.data],
  );

  const create = api.tags.create.useMutation();
  const attach = api.tags.attach.useMutation({
    onSuccess: () => {
      utils.tags.getForNote.invalidate({ noteId });
      utils.notes.getNotes.invalidate();
    },
  });
  const detach = api.tags.detach.useMutation({
    onSuccess: () => {
      utils.tags.getForNote.invalidate({ noteId });
      utils.notes.getNotes.invalidate();
    },
  });

  const lc = query.trim().toLowerCase();
  const exact = (allTags.data ?? []).find((t) => t.name === lc);
  const showCreate = lc.length > 0 && !exact;

  type Tag = NonNullable<typeof allTags.data>[number];
  const filterByQuery = (rows: readonly Tag[] | undefined): Tag[] => {
    if (!rows) return [];
    if (!lc) return [...rows];
    return rows.filter((t) => t.name.includes(lc));
  };

  const recent = filterByQuery(recentTags.data);
  const all = filterByQuery(allTags.data).filter(
    (t) => !recent.some((r) => r.id === t.id),
  );

  const noResults = recent.length === 0 && all.length === 0 && !showCreate;

  const toggle = (tagId: number) => {
    if (attached.has(tagId)) {
      detach.mutate({ noteId, tagId });
    } else {
      attach.mutate({ noteId, tagId });
    }
  };

  const handleCreate = async () => {
    const tag = await create.mutateAsync({ name: lc });
    attach.mutate({ noteId, tagId: tag.id });
    utils.tags.list.invalidate();
    utils.tags.listRecent.invalidate();
    setQuery("");
  };

  return (
    <Combobox
      multiple
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
      inputValue={query}
      onInputValueChange={(value) => setQuery(value)}
      filter={null}
    >
      {trigger}
      <ComboboxContent className="w-72">
        <ComboboxInput placeholder="Search or create a tag…" />
        <ComboboxList>
          {noResults && (
            <div className="px-2 py-2 text-center text-sm text-muted-foreground">
              No tags found.
            </div>
          )}

          {recent.length > 0 && (
            <div>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </div>
              {recent.map((t) => (
                <ComboboxItem
                  key={`r-${t.id}`}
                  value={`r-${t.id}`}
                  onClick={() => toggle(t.id)}
                >
                  <TagHash color={t.color} name={t.name} />
                  {attached.has(t.id) && (
                    <Check className="ml-auto h-3.5 w-3.5" />
                  )}
                </ComboboxItem>
              ))}
            </div>
          )}

          {all.length > 0 && (
            <div>
              <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                All
              </div>
              {all.map((t) => (
                <ComboboxItem
                  key={`a-${t.id}`}
                  value={`a-${t.id}`}
                  onClick={() => toggle(t.id)}
                >
                  <TagHash color={t.color} name={t.name} />
                  {attached.has(t.id) && (
                    <Check className="ml-auto h-3.5 w-3.5" />
                  )}
                </ComboboxItem>
              ))}
            </div>
          )}

          {showCreate && (
            <div className="border-t border-border p-1">
              <ComboboxItem
                value={`__create_${lc}`}
                onClick={() => {
                  void handleCreate();
                }}
              >
                <span className="font-mono">+</span>
                <span className="ml-1">
                  Create <strong>#{lc}</strong>
                </span>
              </ComboboxItem>
            </div>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
