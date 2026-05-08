import * as React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/trpc/react";
import type { Folder } from "@/db/schema";

export function FolderEditDialog({
  folder,
  open,
  onOpenChange,
}: {
  folder: Folder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(folder?.name ?? "");
  const utils = api.useUtils();

  React.useEffect(() => {
    if (folder) setName(folder.name);
  }, [folder]);

  const updateMutation = api.folders.update.useMutation({
    onSuccess: () => {
      utils.folders.invalidate();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  if (!folder) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("settings.notes.folder.rename.title")}
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.notes.folder.rename.placeholder")}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("settings.tags.editDialog.cancel")}
          </Button>
          <Button
            disabled={
              name.trim().length === 0 ||
              name.trim() === folder.name ||
              updateMutation.isPending
            }
            onClick={() =>
              updateMutation.mutate({ id: folder.id, name: name.trim() })
            }
          >
            {t("settings.tags.editDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
