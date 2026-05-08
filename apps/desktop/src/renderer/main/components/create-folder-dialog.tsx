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
  onCreated: (folderId: number) => void;
};

export function CreateFolderDialog({
  open,
  onOpenChange,
  onCreated,
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

  const createMutation = api.folders.create.useMutation({
    onSuccess: (folder) => {
      utils.folders.invalidate();
      onOpenChange(false);
      onCreated(folder.id);
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
    createMutation.mutate({ name: trimmed });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("settings.notes.note.actions.newFolder")}
          </DialogTitle>
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
