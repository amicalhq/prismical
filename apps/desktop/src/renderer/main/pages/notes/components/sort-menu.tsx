import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowUpDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";

type Sort = "updatedAt" | "createdAt" | "title";

export function SortMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { sort?: Sort };
  const sort = search.sort ?? "updatedAt";

  return (
    <Select
      value={sort}
      onValueChange={(v: Sort) =>
        navigate({
          to: "/notes",
          search: ((prev: Record<string, unknown>) => ({
            ...prev,
            sort: v,
          })) as never,
        })
      }
    >
      <SelectTrigger
        aria-label={t("settings.notes.sort.aria")}
        className="h-9 w-40 gap-2 rounded-lg border-transparent bg-accent/40 px-3 text-sm text-muted-foreground shadow-none transition-colors hover:bg-accent/60 focus-visible:ring-0 dark:bg-accent/30 dark:hover:bg-accent/50"
      >
        <ArrowUpDown className="h-4 w-4 shrink-0" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="updatedAt">
          {t("settings.notes.sort.updatedAt")}
        </SelectItem>
        <SelectItem value="createdAt">
          {t("settings.notes.sort.createdAt")}
        </SelectItem>
        <SelectItem value="title">{t("settings.notes.sort.title")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
