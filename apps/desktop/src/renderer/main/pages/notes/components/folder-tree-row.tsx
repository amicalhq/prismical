import * as React from "react";
import { ChevronRight, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { FolderRowMenu } from "@/renderer/main/components/folder/folder-row-menu";
import { FolderEditDialog } from "@/renderer/main/components/folder/folder-edit-dialog";
import { CreateFolderDialog } from "@/renderer/main/components/create-folder-dialog";
import { api } from "@/trpc/react";
import type { Folder as FolderRecord } from "@/db/schema";

export type FolderTreeNode = FolderRecord & {
  noteCount: number;
  children: FolderTreeNode[];
};

type Props = {
  node: FolderTreeNode;
  level: number; // 0 = top-level
  selectedId: number | null; // currently selected folder (or null = none)
  expanded: Set<number>; // expansion state owned by rail
  onToggleExpand: (id: number) => void;
  onSelect: (id: number) => void;
};

export function FolderTreeRow({
  node,
  level,
  selectedId,
  expanded,
  onToggleExpand,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [editing, setEditing] = React.useState<FolderRecord | null>(null);
  const [confirmingDelete, setConfirmingDelete] =
    React.useState<FolderRecord | null>(null);
  const [creatingChild, setCreatingChild] = React.useState(false);

  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === node.id;

  const deleteMutation = api.folders.delete.useMutation({
    onSuccess: (result) => {
      utils.folders.invalidate();
      utils.notes.invalidate();
      utils.tags.invalidate();
      utils.artifacts.invalidate();
      utils.meetings.invalidate();
      setConfirmingDelete(null);
      toast.success(
        t("settings.notes.toast.folderDeleted", {
          noteCount: result.deletedNoteCount,
          folderCount: result.deletedSubfolderCount,
        }),
      );
    },
    onError: (e) =>
      toast.error(
        t("settings.folders.errors.deleteFailed", { message: e.message }),
      ),
  });

  const previewQ = api.folders.getDeletePreview.useQuery(
    { id: confirmingDelete?.id ?? 0 },
    { enabled: confirmingDelete !== null, staleTime: 0, gcTime: 0 },
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node.id);
          }
        }}
        className={`group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 text-sm ${
          isSelected
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${level * 12 + 6}px` }}
      >
        <button
          type="button"
          aria-label={isOpen ? "Collapse" : "Expand"}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent/60"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(node.id);
          }}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
        </button>
        <Folder className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <span className="shrink-0 text-xs tabular-nums opacity-60">
          {node.noteCount}
        </span>
        <span
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="shrink-0"
        >
          <FolderRowMenu
            folder={node}
            onRename={() => setEditing(node)}
            onDelete={() => setConfirmingDelete(node)}
            onCreateSubfolder={() => setCreatingChild(true)}
            triggerClassName="ml-0.5 inline-flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent/60 group-hover:opacity-100 data-[state=open]:opacity-100"
          />
        </span>
      </div>

      {isOpen &&
        node.children.map((child) => (
          <FolderTreeRow
            key={child.id}
            node={child}
            level={level + 1}
            selectedId={selectedId}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onSelect={onSelect}
          />
        ))}

      <FolderEditDialog
        folder={editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      />

      <CreateFolderDialog
        open={creatingChild}
        onOpenChange={setCreatingChild}
        parentId={node.id}
      />

      <AlertDialog
        open={confirmingDelete !== null}
        onOpenChange={(o) => !o && setConfirmingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.notes.folder.delete.title", {
                name: confirmingDelete?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.notes.folder.delete.description", {
                noteCount: previewQ.data?.noteCount ?? 0,
                folderCount: previewQ.data?.subfolderCount ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!previewQ.isSuccess}
              onClick={() => {
                if (confirmingDelete) {
                  deleteMutation.mutate({ id: confirmingDelete.id });
                }
              }}
            >
              {t("settings.notes.folder.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
