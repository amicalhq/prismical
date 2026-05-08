import { useState } from "react";
import { Star } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export function AllTagsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"createdAt" | "name">("createdAt");
  const [editing, setEditing] = useState<Tag | null>(null);
  const [confirming, setConfirming] = useState<Tag | null>(null);

  const q = api.tags.listWithCounts.useQuery({
    search: search.trim() || undefined,
    sortBy,
  });
  const del = api.tags.delete.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      setConfirming(null);
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.deleteFailed", { message: error.message }),
      );
    },
  });
  const totalNotes = (q.data ?? []).reduce((s, r) => s + r.noteCount, 0);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-semibold">{t("settings.tags.title")}</h1>
      <p className="text-sm text-muted-foreground">
        {t("settings.tags.summary", {
          count: q.data?.length ?? 0,
          notes: t("settings.tags.noteCount", { count: totalNotes }),
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
              className="group/row flex items-center gap-2 border-b last:border-b-0 hover:bg-muted/30"
            >
              <button
                type="button"
                className="flex flex-1 items-center gap-2 px-4 py-2 text-left outline-none focus-visible:bg-muted/50"
                onClick={() =>
                  navigate({
                    to: "/settings/notes",
                    search: { tag: tag.id },
                  })
                }
                aria-label={`#${tag.name}`}
              >
                <TagHash color={tag.color} name={tag.name} />
                {tag.isFavorite && (
                  <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                )}
                <span className="flex-1" />
                <span className="tabular-nums text-sm text-muted-foreground">
                  {t("settings.tags.noteCount", { count: tag.noteCount })}
                </span>
              </button>
              <div className="pr-3 opacity-0 focus-within:opacity-100 group-hover/row:opacity-100">
                <TagRowMenu
                  tag={tag}
                  onEdit={() => setEditing(tag)}
                  onDelete={() => setConfirming(tag)}
                />
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

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tags.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tags.deleteConfirmDescription", {
                count: confirming
                  ? ((q.data ?? []).find((r) => r.id === confirming.id)
                      ?.noteCount ?? 0)
                  : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && del.mutate({ id: confirming.id })}
              className="bg-destructive text-foreground hover:bg-destructive/90"
            >
              {t("settings.tags.menu.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
