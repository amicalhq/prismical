import { useNavigate, useSearch } from "@tanstack/react-router";
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
      <SelectTrigger className="h-8 w-32 text-xs">
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
