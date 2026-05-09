import { useState } from "react";
import { Star } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Tag management surface — search, sort, rename, recolor, favorite, delete.
 * Hosted in a dialog and opened from the TagFilterBar's combobox footer.
 *
 * No click-to-filter affordance here: this surface is for managing tags,
 * not selecting them. Filtering happens via the combobox itself.
 */
export function ManageTagsDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"createdAt" | "name">("name");
  const [editing, setEditing] = useState<Tag | null>(null);
  const [confirming, setConfirming] = useState<Tag | null>(null);

  const q = api.tags.listWithCounts.useQuery(
    { search: search.trim() || undefined, sortBy },
    { enabled: open },
  );

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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("settings.tags.title")}</DialogTitle>
            <DialogDescription>
              {t("settings.tags.summary", {
                count: q.data?.length ?? 0,
                notes: t("settings.tags.noteCount", { count: totalNotes }),
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
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
                <SelectItem value="name">
                  {t("settings.tags.sortName")}
                </SelectItem>
                <SelectItem value="createdAt">
                  {t("settings.tags.sortRecent")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="mt-2 max-h-[60vh] overflow-y-auto overflow-hidden rounded-md border">
            {(q.data ?? []).length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t("settings.tags.empty")}
              </div>
            ) : (
              (q.data ?? []).map((tag) => (
                <div
                  key={tag.id}
                  className="group/row flex items-center border-b last:border-b-0 hover:bg-muted/30"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3">
                    <TagHash
                      color={tag.color}
                      name={tag.name}
                      className="min-w-0 flex-1"
                    />
                    {tag.isFavorite && (
                      <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
                    )}
                  </div>
                  <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                    {t("settings.tags.noteCount", { count: tag.noteCount })}
                  </span>
                  <TagRowMenu
                    tag={tag}
                    onEdit={() => setEditing(tag)}
                    onDelete={() => setConfirming(tag)}
                    triggerClassName="mx-3 inline-flex aspect-square w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
                  />
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

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
    </>
  );
}
