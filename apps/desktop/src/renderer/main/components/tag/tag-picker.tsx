import * as React from "react";
import { Check } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  Combobox,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox-radix";
import { api } from "@/trpc/react";
import { TagHash } from "./tag-hash";

const TAG_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export interface TagPickerProps {
  noteId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Element to anchor the Combobox popup to. The picker positions itself
   * against this element via base-ui's positioner.
   */
  anchor: React.RefObject<HTMLElement | null>;
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
  anchor,
}: TagPickerProps) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [query, setQuery] = React.useState("");

  const allTags = api.tags.list.useQuery({ sortBy: "name" });
  const recentTags = api.tags.listRecent.useQuery({ limit: 5 });
  const noteTags = api.tags.getForNote.useQuery({ noteId });

  const attached = React.useMemo(
    () => new Set((noteTags.data ?? []).map((tag) => tag.id)),
    [noteTags.data],
  );

  type Tag = NonNullable<typeof allTags.data>[number];

  const invalidateAll = () => {
    utils.tags.invalidate();
    utils.notes.getNotes.invalidate();
  };

  const attach = api.tags.attach.useMutation({
    onMutate: async ({ tagId }) => {
      await utils.tags.getForNote.cancel({ noteId });
      const previous = utils.tags.getForNote.getData({ noteId });
      const lookup =
        recentTags.data?.find((tag) => tag.id === tagId) ??
        allTags.data?.find((tag) => tag.id === tagId);
      if (lookup) {
        utils.tags.getForNote.setData({ noteId }, (prev) =>
          prev ? [lookup, ...prev.filter((tag) => tag.id !== tagId)] : [lookup],
        );
      }
      return { previous };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) utils.tags.getForNote.setData({ noteId }, ctx.previous);
      toast.error(
        t("settings.tags.errors.attachFailed", { message: error.message }),
      );
    },
    onSettled: invalidateAll,
  });

  const detach = api.tags.detach.useMutation({
    onMutate: async ({ tagId }) => {
      await utils.tags.getForNote.cancel({ noteId });
      const previous = utils.tags.getForNote.getData({ noteId });
      utils.tags.getForNote.setData({ noteId }, (prev) =>
        (prev ?? []).filter((tag) => tag.id !== tagId),
      );
      return { previous };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) utils.tags.getForNote.setData({ noteId }, ctx.previous);
      toast.error(
        t("settings.tags.errors.detachFailed", { message: error.message }),
      );
    },
    onSettled: invalidateAll,
  });

  const create = api.tags.create.useMutation({
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.createFailed", { message: error.message }),
      );
    },
  });

  const lc = query.trim().toLowerCase();
  const exact = (allTags.data ?? []).find((tag) => tag.name === lc);
  const showCreate = lc.length > 0 && TAG_NAME_RE.test(lc) && !exact;

  const filterByQuery = (rows: readonly Tag[] | undefined): Tag[] => {
    if (!rows) return [];
    if (!lc) return [...rows];
    return rows.filter((tag) => tag.name.includes(lc));
  };

  const recent = filterByQuery(recentTags.data);
  const all = filterByQuery(allTags.data).filter(
    (tag) => !recent.some((r) => r.id === tag.id),
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
    utils.tags.invalidate();
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
      <ComboboxContent className="w-72" anchor={() => anchor.current}>
        <ComboboxInput
          placeholder={t("settings.tags.picker.placeholder")}
          showTrigger={false}
        />
        <ComboboxList>
          {noResults && (
            <div className="px-2 py-2 text-center text-sm text-muted-foreground">
              {t("settings.tags.picker.noResults")}
            </div>
          )}

          {recent.length > 0 && (
            <ComboboxGroup>
              <ComboboxLabel className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("settings.tags.picker.recent")}
              </ComboboxLabel>
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
            </ComboboxGroup>
          )}

          {all.length > 0 && (
            <ComboboxGroup>
              <ComboboxLabel className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("settings.tags.picker.all")}
              </ComboboxLabel>
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
            </ComboboxGroup>
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
                  <Trans
                    i18nKey="settings.tags.picker.create"
                    values={{ name: lc }}
                    components={{ 1: <strong /> }}
                  />
                </span>
              </ComboboxItem>
            </div>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
