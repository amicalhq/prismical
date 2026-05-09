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
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox-radix";
import { Skeleton } from "@/components/ui/skeleton";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";
import { api } from "@/trpc/react";
import { ManageTagsDialog } from "./manage-tags-dialog";

const TAG_NAME_RE = /^[a-z0-9_-]{1,32}$/;

// Sentinel values for non-tag actions inside the combobox list. They're
// strings cast to satisfy the Combobox<number, true> generic and intercepted
// in handleValueChange so they never leak into the URL's number[] tags param.
const MANAGE_VALUE = "__manage_tags__";

// Reserved space inside the chips container (in px). Tuned against the
// rendered widths of each fixed-position element:
//   INPUT_RESERVE     — matches `min-w-12` (48px) on ComboboxChipsInput, with
//                       a small slack so the cursor isn't flush against the
//                       previous chip.
//   INDICATOR_RESERVE — covers the widest realistic "+N" pill (e.g. "+99")
//                       at text-xs with px-1 padding.
//   CLEAR_RESERVE     — matches the size-5 (20px) clear button + the gap
//                       between it and the input.
//   CHIP_GAP          — `gap-1.5` (6px) between flex children, applied between
//                       chips and between chips/indicator/input.
// Trim these if you tighten the typography; widen if you make any of those
// elements bigger.
const INPUT_RESERVE = 40;
const INDICATOR_RESERVE = 28;
const CLEAR_RESERVE = 24;
const CHIP_GAP = 6;

function ChipBody({ tag }: { tag: { color: string; name: string } }) {
  return (
    <span className="flex items-baseline gap-0.5">
      <span className="font-mono font-bold leading-none">#</span>
      <span className="truncate">{tag.name}</span>
    </span>
  );
}

/**
 * Plain-div chip used in a hidden mirror layer to measure each chip's
 * natural width. Mirrors `ComboboxChip`'s default classes plus an X-button
 * placeholder so its `offsetWidth` matches the rendered chip.
 */
function MeasureChip({ tag }: { tag: { color: string; name: string } }) {
  return (
    <div
      className="flex h-[calc(--spacing(5.5))] w-fit items-center gap-1 rounded-sm bg-transparent px-1.5 text-xs font-medium whitespace-nowrap"
      style={{ backgroundColor: `${tag.color}26`, color: tag.color }}
    >
      <ChipBody tag={tag} />
      {/* Width-parity placeholder for the chip-remove icon-xs Button. */}
      <span aria-hidden="true" className="-ml-1 inline-block size-6" />
    </div>
  );
}

/**
 * Dynamic chip overflow: render every selected chip in an off-screen
 * measurement layer to read each `offsetWidth`, then greedy-fit them
 * against the container's available inner width minus space reserved for
 * the input, indicator, and clear button. Re-runs on container resize and
 * when the chip set itself changes (add/remove/rename/recolor).
 *
 * Returns the count of chips that fit visibly. The remainder collapse into
 * a "+N" indicator so the bar never overflows or clips.
 */
function useChipOverflow(
  containerRef: React.RefObject<HTMLDivElement | null>,
  measureRef: React.RefObject<HTMLDivElement | null>,
  totalChips: number,
  hasClear: boolean,
): number {
  const [visibleCount, setVisibleCount] = React.useState(totalChips);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const compute = () => {
      const chips = Array.from(measure.children) as HTMLElement[];
      if (chips.length === 0) {
        setVisibleCount(0);
        return;
      }

      const cs = getComputedStyle(container);
      const innerWidth =
        container.clientWidth -
        parseFloat(cs.paddingLeft || "0") -
        parseFloat(cs.paddingRight || "0");

      const baseReserve = INPUT_RESERVE + (hasClear ? CLEAR_RESERVE : 0);

      // Pass 1: do all chips fit without an overflow indicator?
      let allTotal = 0;
      for (let i = 0; i < chips.length; i++) {
        allTotal += chips[i].offsetWidth + (i > 0 ? CHIP_GAP : 0);
      }
      if (allTotal + baseReserve <= innerWidth) {
        setVisibleCount(chips.length);
        return;
      }

      // Pass 2: reserve room for the indicator and greedy-fit the rest.
      const limit = innerWidth - baseReserve - INDICATOR_RESERVE;
      let used = 0;
      let count = 0;
      for (let i = 0; i < chips.length; i++) {
        const w = chips[i].offsetWidth + (i > 0 ? CHIP_GAP : 0);
        if (used + w > limit) break;
        used += w;
        count++;
      }
      setVisibleCount(count);
    };

    compute();
    // Re-fit on container width changes.
    const containerObserver = new ResizeObserver(compute);
    containerObserver.observe(container);
    // Re-fit when measurement chips themselves change size (e.g. tag
    // rename or recolor while the bar is mounted).
    const measureObserver = new ResizeObserver(compute);
    measureObserver.observe(measure);
    return () => {
      containerObserver.disconnect();
      measureObserver.disconnect();
    };
  }, [containerRef, measureRef, totalChips, hasClear]);

  // Clamp in case the chip count shrank between effect runs.
  return Math.min(visibleCount, totalChips);
}

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

  // base-ui anchor (RefObject) for popover positioning. We share the same
  // DOM node with our own ResizeObserver via a callback ref below.
  const anchor = useComboboxAnchor();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const setContainerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      anchor.current = node;
      containerRef.current = node;
    },
    [anchor],
  );
  const measureRef = React.useRef<HTMLDivElement>(null);

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

  // Resolve which selected ids correspond to known tags right now (data may
  // not be loaded on first render). The measurement layer renders these.
  const resolved = React.useMemo(
    () =>
      selectedIds
        .map((id) => tagById.get(id))
        .filter((t): t is NonNullable<typeof t> => !!t),
    [selectedIds, tagById],
  );

  const hasClear = selectedIds.length > 0 || query.length > 0;
  const visibleCount = useChipOverflow(
    containerRef,
    measureRef,
    resolved.length,
    hasClear,
  );

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

  if (tagsQ.isLoading) {
    return (
      <Skeleton className="h-9 min-w-[180px] max-w-[260px] flex-1 rounded-lg" />
    );
  }

  // Tag picks fire onValueChange with the new array. The "create" and
  // "manage" sentinels piggyback on that signal — we intercept and strip
  // them so they never reach the URL.
  const handleValueChange = (next: unknown) => {
    const ids = (next as Array<number | string>) ?? [];
    if (ids.includes(MANAGE_VALUE)) {
      setManageOpen(true);
      setTags(ids.filter((v): v is number => typeof v === "number"));
      return;
    }
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
      {/* Hidden measurement mirror — renders every selected chip with the
          same visual structure as the visible chips so we can read each
          one's offsetWidth and decide which fit the container. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none fixed -top-[9999px] -left-[9999px] flex gap-1.5"
      >
        {resolved.map((tag) => (
          <MeasureChip key={tag.id} tag={tag} />
        ))}
      </div>

      <Combobox<number, true>
        multiple
        value={selectedIds}
        onValueChange={handleValueChange}
        inputValue={query}
        onInputValueChange={setQuery}
        filter={null}
      >
        <ComboboxChips
          ref={setContainerRef}
          className="h-9 min-w-[180px] max-w-[260px] flex-1 flex-nowrap overflow-clip rounded-lg border-transparent bg-accent/40 px-2 hover:bg-accent/60 dark:bg-accent/30 dark:hover:bg-accent/50"
        >
          <ComboboxValue>
            {(values) => {
              const ids = (values as number[]) ?? [];
              // Visible ids = the leading slice that fits, intersected with
              // ids the data layer knows about (avoids rendering empty chips
              // for stale ids while the list query is loading).
              const knownIds = ids.filter((id) => tagById.has(id));
              const visible = knownIds.slice(0, visibleCount);
              const overflow = ids.length - visible.length;
              return (
                <>
                  {visible.map((id) => {
                    const tag = tagById.get(id)!;
                    return (
                      <ComboboxChip
                        key={id}
                        className="gap-1 bg-transparent px-1.5"
                        style={{
                          backgroundColor: `${tag.color}26`,
                          color: tag.color,
                        }}
                      >
                        <ChipBody tag={tag} />
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
          <ComboboxClear
            aria-label={t("settings.tags.filterBar.clear")}
            className="ml-auto size-5 shrink-0"
          />
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
                // Cast: Combobox is generic over number, but this row's value
                // is a string sentinel intercepted in handleValueChange.
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
