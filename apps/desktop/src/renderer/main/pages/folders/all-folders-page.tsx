import { useState } from "react";
import { Folder as FolderIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import { Button } from "@/components/ui/button";
import { FolderEditDialog } from "@/renderer/main/components/folder/folder-edit-dialog";
import { FolderRowMenu } from "@/renderer/main/components/folder/folder-row-menu";
import { CreateFolderDialog } from "@/renderer/main/components/create-folder-dialog";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import type { Folder } from "@/db/schema";

export function AllFoldersPage() {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"createdAt" | "name">("name");
  const [editing, setEditing] = useState<Folder | null>(null);
  const [confirming, setConfirming] = useState<Folder | null>(null);
  const [creating, setCreating] = useState(false);

  const q = api.folders.listWithCounts.useQuery({
    search: search.trim() || undefined,
    sortBy,
  });

  const deleteMutation = api.folders.delete.useMutation({
    onSuccess: (result) => {
      utils.folders.invalidate();
      utils.notes.invalidate();
      utils.tags.invalidate();
      utils.artifacts.invalidate();
      utils.meetings.invalidate();
      setConfirming(null);
      toast.success(
        t("settings.notes.toast.folderDeleted", {
          noteCount: result.deletedNoteCount,
          folderCount: result.deletedSubfolderCount,
        }),
      );
    },
    onError: (error) =>
      toast.error(
        t("settings.folders.errors.deleteFailed", { message: error.message }),
      ),
  });

  const deletePreviewQ = api.folders.getDeletePreview.useQuery(
    { id: confirming?.id ?? 0 },
    { enabled: confirming !== null, staleTime: 0, gcTime: 0 },
  );

  const totalNotes = (q.data ?? []).reduce((s, r) => s + r.noteCount, 0);

  return (
    <div className="mx-auto w-full max-w-[720px] p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            {t("settings.folders.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("settings.folders.summary", {
              count: q.data?.length ?? 0,
              notes: t("settings.folders.noteCount", { count: totalNotes }),
            })}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          {t("settings.folders.actions.create")}
        </Button>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.folders.searchPlaceholder")}
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

      <div className="mt-4 overflow-hidden rounded-md border">
        {(q.data ?? []).length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {t("settings.folders.empty")}
          </div>
        ) : (
          (q.data ?? []).map((row) => (
            <div
              key={row.id}
              className="group/row flex items-center border-b last:border-b-0 hover:bg-muted/30"
            >
              <div className="flex min-w-0 flex-1 items-center gap-4 px-5 py-3">
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {row.name}
                </span>
              </div>
              <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                {t("settings.folders.noteCount", { count: row.noteCount })}
              </span>
              <FolderRowMenu
                folder={row}
                onRename={() => setEditing(row)}
                onDelete={() => setConfirming(row)}
                triggerClassName="mx-3 inline-flex aspect-square w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
              />
            </div>
          ))
        )}
      </div>

      <FolderEditDialog
        folder={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <CreateFolderDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          /* list auto-invalidates via the dialog's mutation */
        }}
      />

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.notes.folder.delete.title", {
                name: confirming?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.notes.folder.delete.description", {
                noteCount: deletePreviewQ.data?.noteCount ?? 0,
                folderCount: deletePreviewQ.data?.subfolderCount ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!deletePreviewQ.isSuccess}
              onClick={() => {
                if (confirming) {
                  deleteMutation.mutate({ id: confirming.id });
                }
              }}
            >
              {t("settings.notes.folder.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
