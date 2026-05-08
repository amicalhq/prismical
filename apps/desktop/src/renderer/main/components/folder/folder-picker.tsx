import * as React from "react";
import { Folder as FolderIcon } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  Combobox,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox-radix";
import { api } from "@/trpc/react";

export interface FolderPickerProps {
  currentFolderId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (folderId: number | null) => void;
  /**
   * Element to anchor the picker popup to. Mirrors `TagPicker`'s contract —
   * base-ui's positioner reads from `anchor.current` on each open.
   */
  anchor: React.RefObject<HTMLElement | null>;
}

/**
 * Single-select folder combobox + create-on-the-fly footer.
 *
 * The component is fully controlled by the parent (`open` / `onOpenChange`).
 * Selecting any folder calls `onSelect(folderId | null)` and closes; the
 * "Create '<query>'" footer is shown when the trimmed query has no exact
 * match (case-insensitive) and runs `folders.create` then `onSelect(newId)`.
 */
export function FolderPicker({
  currentFolderId,
  open,
  onOpenChange,
  onSelect,
  anchor,
}: FolderPickerProps) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const [query, setQuery] = React.useState("");

  const foldersQ = api.folders.list.useQuery({ sortBy: "name" });

  const create = api.folders.create.useMutation({
    onError: (error) => {
      toast.error(
        t("settings.folders.errors.createFailed", { message: error.message }),
      );
    },
  });

  const trimmed = query.trim();
  const lc = trimmed.toLowerCase();
  const folders = foldersQ.data ?? [];
  const exact = folders.find((f) => f.name.toLowerCase() === lc);
  const showCreate = trimmed.length > 0 && !exact;

  const filtered = React.useMemo(() => {
    if (!lc) return folders;
    return folders.filter((f) => f.name.toLowerCase().includes(lc));
  }, [folders, lc]);

  const handleSelect = (folderId: number | null) => {
    onSelect(folderId);
    onOpenChange(false);
    setQuery("");
  };

  const handleCreate = async () => {
    try {
      const folder = await create.mutateAsync({ name: trimmed });
      utils.folders.invalidate();
      handleSelect(folder.id);
    } catch {
      // create.onError already surfaced a toast.
    }
  };

  const noResults = filtered.length === 0 && !showCreate;

  const selectedValue =
    currentFolderId === null ? "__none" : `f-${currentFolderId}`;

  return (
    <Combobox
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
      value={selectedValue}
      inputValue={query}
      onInputValueChange={(value) => setQuery(value)}
      filter={null}
    >
      <ComboboxContent className="w-72" anchor={() => anchor.current}>
        <ComboboxInput
          placeholder={t("settings.notes.folder.picker.placeholder")}
          showTrigger={false}
        />
        <ComboboxList>
          {noResults && (
            <div className="px-2 py-2 text-center text-sm text-muted-foreground">
              {t("settings.notes.note.actions.noFoldersFound")}
            </div>
          )}

          <ComboboxGroup>
            <ComboboxItem
              value="__none"
              onClick={() => handleSelect(null)}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center" />
              <span>{t("settings.notes.note.actions.noFolder")}</span>
            </ComboboxItem>
            {filtered.map((f) => (
              <ComboboxItem
                key={f.id}
                value={`f-${f.id}`}
                onClick={() => handleSelect(f.id)}
              >
                <FolderIcon className="h-4 w-4" />
                <span className="truncate">{f.name}</span>
              </ComboboxItem>
            ))}
          </ComboboxGroup>

          {showCreate && (
            <div className="border-t border-border p-1">
              <ComboboxItem
                value={`__create_${trimmed}`}
                onClick={() => {
                  void handleCreate();
                }}
              >
                <span className="font-mono">+</span>
                <span className="ml-1">
                  <Trans
                    i18nKey="settings.notes.folder.picker.create"
                    values={{ name: trimmed }}
                    components={{ 1: <strong /> }}
                  />
                </span>
              </ComboboxItem>
            </div>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
