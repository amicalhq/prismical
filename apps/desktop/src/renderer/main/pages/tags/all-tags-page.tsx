import { useState } from "react";
import { Star } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";
import { TagRowMenu } from "@/renderer/main/components/tag/tag-row-menu";
import { TagEditDialog } from "@/renderer/main/components/tag/tag-edit-dialog";
import { api } from "@/trpc/react";
import type { Tag } from "@/db/schema";

export function AllTagsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"createdAt" | "name">("createdAt");
  const [editing, setEditing] = useState<Tag | null>(null);

  const q = api.tags.listWithCounts.useQuery({
    search: search.trim() || undefined,
    sortBy,
  });
  const totalNotes = (q.data ?? []).reduce((s, r) => s + r.noteCount, 0);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{t("settings.tags.title")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("settings.tags.summary", {
          count: q.data?.length ?? 0,
          noteCount: totalNotes,
        })}
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.tags.searchPlaceholder")}
          className="max-w-xs"
        />
        <Select
          value={sortBy}
          onValueChange={(v) => setSortBy(v as "createdAt" | "name")}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="createdAt">
              {t("settings.tags.sortRecent")}
            </SelectItem>
            <SelectItem value="name">{t("settings.tags.sortName")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        {(q.data ?? []).length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {t("settings.tags.empty")}
          </div>
        ) : (
          (q.data ?? []).map((tag) => (
            <div
              key={tag.id}
              className="group/row flex cursor-pointer items-center gap-2 border-b px-4 py-2 last:border-b-0 hover:bg-muted/30"
              onClick={() =>
                navigate({
                  to: "/settings/notes",
                  search: { tag: tag.id },
                })
              }
            >
              <TagHash color={tag.color} name={tag.name} />
              {tag.isFavorite && (
                <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
              )}
              <span className="flex-1" />
              <span className="tabular-nums text-sm text-muted-foreground">
                {tag.noteCount} note{tag.noteCount === 1 ? "" : "s"}
              </span>
              <div
                className="opacity-0 group-hover/row:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <TagRowMenu tag={tag} onEdit={() => setEditing(tag)} />
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <TagEditDialog
          tag={editing}
          noteCount={
            (q.data ?? []).find((r) => r.id === editing.id)?.noteCount ?? 0
          }
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  );
}
