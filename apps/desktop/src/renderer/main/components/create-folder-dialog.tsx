import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type CreateFolderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (folderName: string) => void;
};

export function CreateFolderDialog({
  open,
  onOpenChange,
  onConfirm,
}: CreateFolderDialogProps) {
  const { t } = useTranslation();
  const [folderName, setFolderName] = useState("");
  const submittedRef = useRef(false);

  useEffect(() => {
    if (open) {
      setFolderName("");
      submittedRef.current = false;
    }
  }, [open]);

  const handleSubmit = () => {
    const trimmed = folderName.trim();
    if (!trimmed || submittedRef.current) return;
    submittedRef.current = true;
    onOpenChange(false);
    onConfirm(trimmed);
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
            disabled={!folderName.trim()}
          >
            {t("settings.notes.note.actions.createFolder")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
