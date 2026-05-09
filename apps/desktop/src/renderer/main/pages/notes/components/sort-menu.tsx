import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";

type Sort = "updatedAt" | "createdAt" | "title";
type SortOrder = "asc" | "desc";

// Composite values keep the URL params atomic — picking an item writes
// both `sort` and `sortOrder` in one navigate call.
const COMBOS: Array<{ sort: Sort; order: SortOrder }> = [
  { sort: "updatedAt", order: "desc" },
  { sort: "updatedAt", order: "asc" },
  { sort: "createdAt", order: "desc" },
  { sort: "createdAt", order: "asc" },
  { sort: "title", order: "asc" },
  { sort: "title", order: "desc" },
];

const encode = (c: { sort: Sort; order: SortOrder }) => `${c.sort}-${c.order}`;
const decode = (v: string): { sort: Sort; order: SortOrder } => {
  const [sort, order] = v.split("-") as [Sort, SortOrder];
  return { sort, order };
};

export function SortMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    sort?: Sort;
    sortOrder?: SortOrder;
  };
  const sort = search.sort ?? "updatedAt";
  const order = search.sortOrder ?? "desc";
  const value = encode({ sort, order });

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const next = decode(v);
        navigate({
          to: "/notes",
          search: ((prev: Record<string, unknown>) => ({
            ...prev,
            sort: next.sort,
            sortOrder: next.order,
          })) as never,
        });
      }}
    >
      <SelectTrigger
        aria-label={t("settings.notes.sort.aria")}
        className="h-9 w-36 shrink-0 gap-2 rounded-lg border-transparent bg-accent/40 px-3 text-sm text-muted-foreground shadow-none transition-colors hover:bg-accent/60 focus-visible:ring-0 dark:bg-accent/30 dark:hover:bg-accent/50"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {COMBOS.map((c) => {
          const Arrow = c.order === "asc" ? ArrowUp : ArrowDown;
          return (
            <SelectItem key={encode(c)} value={encode(c)}>
              <span>{t(`settings.notes.sort.${c.sort}`)}</span>
              <Arrow className="h-3 w-3 text-muted-foreground" />
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
