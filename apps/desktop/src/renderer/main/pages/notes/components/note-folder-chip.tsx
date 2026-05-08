import { useRef, useState } from "react";
import { Folder as FolderIcon, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Folder } from "@/db/schema";
import { cn } from "@/lib/utils";
import { FolderPicker } from "@/renderer/main/components/folder/folder-picker";

interface NoteFolderChipProps {
  noteFolderId: number | null;
  folders: Folder[];
  onSelect: (folderId: number | null) => void;
  isNarrow?: boolean;
}

const PILL_BASE =
  "group/folder-chip inline-flex h-[22px] min-w-0 max-w-full items-center gap-1 rounded-full border px-2 text-[11px] text-muted-foreground hover:text-foreground";

export function NoteFolderChip({
  noteFolderId,
  folders,
  onSelect,
  isNarrow,
}: NoteFolderChipProps) {
  const { t } = useTranslation();
  const folder = folders.find((f) => f.id === noteFolderId) ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);

  const togglePicker = () => setPickerOpen((o) => !o);

  const picker = (
    <FolderPicker
      currentFolderId={noteFolderId}
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      onSelect={onSelect}
      anchor={triggerRef}
    />
  );

  if (isNarrow) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePicker}
          className={cn(PILL_BASE, "border-dashed")}
          aria-label={t("settings.notes.note.actions.folderLabel")}
        >
          <FolderIcon className="h-3 w-3" />
          {folder ? <span className="truncate">{folder.name}</span> : null}
        </button>
        {picker}
      </>
    );
  }

  if (!folder) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePicker}
          aria-label={t("settings.notes.note.actions.addToFolder")}
          className={cn(PILL_BASE, "border-dashed")}
        >
          <Plus className="h-3 w-3" />
          {t("settings.notes.note.actions.addToFolder")}
        </button>
        {picker}
      </>
    );
  }

  return (
    <>
      <span className={cn(PILL_BASE, "bg-muted/50")}>
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePicker}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FolderIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
        <button
          ref={removeRef}
          type="button"
          aria-label={t("settings.notes.note.actions.removeFromFolderNamed", {
            name: folder.name,
          })}
          onClick={() => onSelect(null)}
          className="ml-0.5 hidden h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full hover:bg-black/20 focus-visible:flex group-hover/folder-chip:flex group-focus-within/folder-chip:flex"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
      {picker}
    </>
  );
}
