import { FolderOpen, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Folder } from "@/db/schema";
import { cn } from "@/lib/utils";

interface NoteFolderChipProps {
  noteFolderId: number | null;
  folders: Folder[];
  onOpenPicker: () => void;
  onClear: () => void;
  isNarrow?: boolean;
}

const PILL_BASE =
  "group/folder-chip inline-flex h-[22px] min-w-0 max-w-full items-center gap-1 rounded-full border px-2 text-[11px] text-muted-foreground hover:text-foreground";

export function NoteFolderChip({
  noteFolderId,
  folders,
  onOpenPicker,
  onClear,
  isNarrow,
}: NoteFolderChipProps) {
  const { t } = useTranslation();
  const folder = folders.find((f) => f.id === noteFolderId) ?? null;

  if (isNarrow) {
    return (
      <button
        type="button"
        onClick={onOpenPicker}
        className={cn(PILL_BASE, "border-dashed")}
        aria-label={t("settings.notes.note.actions.folderLabel")}
      >
        <FolderOpen className="h-3 w-3" />
        {folder ? <span className="truncate">{folder.name}</span> : null}
      </button>
    );
  }

  if (!folder) {
    return (
      <button
        type="button"
        onClick={onOpenPicker}
        aria-label={t("settings.notes.note.actions.addToFolder")}
        className={cn(PILL_BASE, "border-dashed")}
      >
        <Plus className="h-3 w-3" />
        {t("settings.notes.note.actions.addToFolder")}
      </button>
    );
  }

  return (
    <span className={cn(PILL_BASE, "bg-muted/50")}>
      <button
        type="button"
        onClick={onOpenPicker}
        className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FolderOpen className="h-3 w-3 shrink-0" />
        <span className="truncate">{folder.name}</span>
      </button>
      <button
        type="button"
        aria-label={t("settings.notes.note.actions.removeFromFolderNamed", {
          name: folder.name,
        })}
        onClick={onClear}
        className="ml-0.5 hidden h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full hover:bg-black/20 focus-visible:flex group-hover/folder-chip:flex group-focus-within/folder-chip:flex"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
