import { Check, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

type FolderPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFolderId: number | null;
  folderIds: number[];
  onSelect: (folderId: number | null) => void;
  onCreateFolder: () => void;
};

export function FolderPickerDialog({
  open,
  onOpenChange,
  currentFolderId,
  folderIds,
  onSelect,
  onCreateFolder,
}: FolderPickerDialogProps) {
  const { t } = useTranslation();

  const handleSelect = (folderId: number | null) => {
    onSelect(folderId);
    onOpenChange(false);
  };

  const handleCreateFolder = () => {
    onOpenChange(false);
    onCreateFolder();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-sm">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {t("settings.notes.note.actions.moveToFolder")}
          </DialogTitle>
          <DialogDescription>
            {t("settings.notes.note.actions.moveToFolder")}
          </DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput
            placeholder={t("settings.notes.note.actions.searchFolders")}
          />
          <CommandList>
            <CommandEmpty>
              {t("settings.notes.note.actions.noFoldersFound")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem onSelect={() => handleSelect(null)}>
                <Check
                  className={`h-4 w-4 ${currentFolderId === null ? "opacity-100" : "opacity-0"}`}
                />
                <span>{t("settings.notes.note.actions.noFolder")}</span>
              </CommandItem>
              {folderIds.map((id) => (
                <CommandItem key={id} onSelect={() => handleSelect(id)}>
                  <Check
                    className={`h-4 w-4 ${currentFolderId === id ? "opacity-100" : "opacity-0"}`}
                  />
                  <span>{String(id)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem onSelect={handleCreateFolder}>
                <FolderPlus className="h-4 w-4" />
                <span>{t("settings.notes.note.actions.newFolder")}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
