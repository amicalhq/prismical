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
  // Single stable wrapper element so base-ui's positioner anchor never
  // detaches mid-close. Selecting a folder both closes the popup AND flips
  // the chip's state — if the trigger were a fresh element per branch, the
  // ref would briefly resolve to null while the popup is still animating
  // closed and the popup would flicker at (0,0).
  const triggerRef = useRef<HTMLSpanElement>(null);

  const togglePicker = () => setPickerOpen((o) => !o);

  const showLabel = !(isNarrow && !folder);
  const Icon = !folder && !isNarrow ? Plus : FolderIcon;
  const labelText = folder
    ? folder.name
    : t("settings.notes.note.actions.addToFolder");
  const ariaLabel = folder
    ? t("settings.notes.note.actions.folderLabel")
    : t("settings.notes.note.actions.addToFolder");

  return (
    <>
      <span
        ref={triggerRef}
        className={cn(PILL_BASE, folder ? "bg-muted/50" : "border-dashed")}
      >
        <button
          type="button"
          onClick={togglePicker}
          aria-label={ariaLabel}
          className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className="h-3 w-3 shrink-0" />
          {showLabel ? <span className="truncate">{labelText}</span> : null}
        </button>
        {folder && !isNarrow ? (
          <button
            type="button"
            aria-label={t("settings.notes.note.actions.removeFromFolderNamed", {
              name: folder.name,
            })}
            onClick={() => onSelect(null)}
            className="ml-0.5 hidden h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full hover:bg-black/20 focus-visible:flex group-hover/folder-chip:flex"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        ) : null}
      </span>
      <FolderPicker
        currentFolderId={noteFolderId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={onSelect}
        anchor={triggerRef}
      />
    </>
  );
}
