import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderTreeRail } from "./folder-tree-rail";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Folder management surface — full tree with rename / delete / new-subfolder
 * via row menus, and a "+" button to create root folders. Hosted in a
 * dialog and opened from the FolderPicker's combobox footer.
 *
 * Selection from the tree (clicking a row) still navigates to /notes with
 * the chosen folder filter; the dialog stays open so the user can manage
 * additional folders without reopening.
 */
export function ManageFoldersDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.folders.manage.title")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <FolderTreeRail />
        </div>
      </DialogContent>
    </Dialog>
  );
}
