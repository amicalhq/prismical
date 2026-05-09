import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { api } from "@/trpc/react";

type CreateFolderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (folderId: number) => void;
  /** When set, the new folder is created as a child of this folder. */
  parentId?: number;
};

export function CreateFolderDialog({
  open,
  onOpenChange,
  onCreated,
  parentId,
}: CreateFolderDialogProps) {
  const { t } = useTranslation();
  const [folderName, setFolderName] = useState("");
  const submittedRef = useRef(false);
  const utils = api.useUtils();

  useEffect(() => {
    if (open) {
      setFolderName("");
      submittedRef.current = false;
    }
  }, [open]);

  const parentQ = api.folders.getById.useQuery(
    { id: parentId ?? 0 },
    { enabled: parentId !== undefined },
  );

  const createMutation = api.folders.create.useMutation({
    onSuccess: (folder) => {
      utils.folders.invalidate();
      onOpenChange(false);
      onCreated?.(folder.id);
    },
    onError: (error) => {
      submittedRef.current = false;
      toast.error(error.message);
    },
  });

  const handleSubmit = () => {
    const trimmed = folderName.trim();
    if (!trimmed || submittedRef.current) return;
    submittedRef.current = true;
    createMutation.mutate({ name: trimmed, parentId });
  };

  const title =
    parentId !== undefined && parentQ.data
      ? t("settings.notes.note.actions.newSubfolder", {
          parent: parentQ.data.name,
        })
      : t("settings.notes.note.actions.newFolder");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleSubmit();
            }
          }}
          placeholder={t("settings.notes.note.actions.newFolderPrompt")}
        />
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!folderName.trim() || createMutation.isPending}
          >
            {t("settings.notes.note.actions.createFolder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
