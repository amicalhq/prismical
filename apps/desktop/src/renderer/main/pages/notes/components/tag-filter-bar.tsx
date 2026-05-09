import * as React from "react";
import { Plus, X } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";
import { api } from "@/trpc/react";
import { TagFilterPopover } from "./tag-filter-popover";

export function TagFilterBar(): React.JSX.Element {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tags?: number[] };
  const selectedIds = React.useMemo(
    () => search.tags ?? [],
    [search.tags],
  );

  const tagsQuery = api.tags.list.useQuery({ sortBy: "name" });
  const tagById = React.useMemo(
    () => Object.fromEntries((tagsQuery.data ?? []).map((t) => [t.id, t])),
    [tagsQuery.data],
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

  const toggle = (id: number) => {
    setTags(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id],
    );
  };

  const remove = (id: number) => {
    setTags(selectedIds.filter((x) => x !== id));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <TagFilterPopover
        trigger={
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full bg-accent/40 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/60 dark:bg-accent/30 dark:hover:bg-accent/50"
          >
            <Plus className="h-3 w-3" /> Tag
          </button>
        }
        selectedTagIds={selectedIds}
        onToggle={toggle}
      />
      {selectedIds.map((id) => {
        const tag = tagById[id];
        if (!tag) return null;
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs"
            style={{ backgroundColor: `${tag.color}26`, color: tag.color }}
          >
            <TagHash color={tag.color} name={tag.name} />
            <button
              type="button"
              onClick={() => remove(id)}
              className="ml-0.5 inline-flex items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
              aria-label={`Remove tag #${tag.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
