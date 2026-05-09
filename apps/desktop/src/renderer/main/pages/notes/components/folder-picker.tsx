import * as React from "react";
import { Folder as FolderIcon, Settings2 } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox-radix";
import { api } from "@/trpc/react";
import { ManageFoldersDialog } from "./manage-folders-dialog";

type FolderRow = {
  id: number;
  name: string;
  parentId: number | null;
  isFavorite: boolean;
  createdAt: Date;
  updatedAt: Date;
  noteCount: number;
};

// Sentinel row for the "Manage folders…" footer item. Its negative id is
// detected in onValueChange and the dialog is opened instead of writing a
// folder filter to the URL. id < 0 can never collide with a real folder
// because folder ids autoincrement from 1.
const MANAGE_ID = -1;

const MANAGE_ROW: FolderRow = {
  id: MANAGE_ID,
  name: "",
  parentId: null,
  isFavorite: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  noteCount: 0,
};

/**
 * Single-select folder picker for the /notes browser toolbar. Replaces the
 * left-side folder rail. ComboboxInput doubles as the trigger; the input
 * shows the selected folder's path (e.g. "Work / Q4") or the "All notes"
 * placeholder when nothing is selected. Clear button resets to "all notes".
 *
 * Selection is owned by the URL `?folder=<id>` search param.
 */
export function FolderPicker() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const search = useSearch({ strict: false }) as { folder?: number };
  const folderId = search.folder;

  const treeQ = api.folders.tree.useQuery();
  const folders: FolderRow[] = React.useMemo(
    () => treeQ.data?.folders ?? [],
    [treeQ.data?.folders],
  );

  const folderById = React.useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  // Precompute "Parent / Child / Grandchild" for each folder so the input
  // shows the full path of the selected folder and the dropdown rows
  // disambiguate same-named siblings under different parents.
  const pathById = React.useMemo(() => {
    const cache = new Map<number, string>();
    function pathOf(id: number): string {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const f = folderById.get(id);
      if (!f) return "";
      const path = f.parentId
        ? `${pathOf(f.parentId)} / ${f.name}`
        : f.name;
      cache.set(id, path);
      return path;
    }
    folders.forEach((f) => pathOf(f.id));
    return cache;
  }, [folders, folderById]);

  const selectedFolder =
    folderId !== undefined ? (folderById.get(folderId) ?? null) : null;

  const [query, setQuery] = React.useState("");
  const [manageOpen, setManageOpen] = React.useState(false);

  const lc = query.trim().toLowerCase();
  const filtered = lc
    ? folders.filter(
        (f) =>
          f.name.toLowerCase().includes(lc) ||
          (pathById.get(f.id) ?? "").toLowerCase().includes(lc),
      )
    : folders;

  const setFolder = (id: number | undefined) => {
    navigate({
      to: "/notes",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        folder: id,
      })) as never,
    });
  };

  const handleValueChange = (next: FolderRow | null) => {
    if (next?.id === MANAGE_ID) {
      setManageOpen(true);
      return;
    }
    setFolder(next?.id);
  };

  return (
    <>
      <Combobox<FolderRow, false>
        value={selectedFolder}
        onValueChange={handleValueChange}
        itemToStringLabel={(f) =>
          f.id === MANAGE_ID ? "" : (pathById.get(f.id) ?? f.name)
        }
        isItemEqualToValue={(a, b) => a.id === b.id}
        inputValue={query}
        onInputValueChange={setQuery}
        filter={null}
      >
        <ComboboxInput
          placeholder={t("settings.folders.picker.placeholder")}
          showClear
          className="h-9 min-w-[180px] max-w-[260px] flex-1 rounded-lg border-transparent bg-accent/40 px-3 text-sm shadow-none hover:bg-accent/60 dark:bg-accent/30 dark:hover:bg-accent/50"
        />
        <ComboboxContent className="w-72">
          <ComboboxList>
            {filtered.length === 0 && (
              <ComboboxEmpty>
                {t("settings.folders.picker.empty")}
              </ComboboxEmpty>
            )}
            {filtered.map((folder) => (
              <ComboboxItem
                key={folder.id}
                value={folder}
                className="flex items-center gap-2"
              >
                <FolderIcon className="h-4 w-4 shrink-0 text-amber-500/80" />
                <span className="min-w-0 flex-1 truncate">
                  {pathById.get(folder.id) ?? folder.name}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {folder.noteCount}
                </span>
              </ComboboxItem>
            ))}

            <ComboboxSeparator />

            <ComboboxItem value={MANAGE_ROW} className="text-muted-foreground">
              <Settings2 className="h-4 w-4" />
              <span>{t("settings.folders.picker.manage")}</span>
            </ComboboxItem>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      <ManageFoldersDialog open={manageOpen} onOpenChange={setManageOpen} />
    </>
  );
}
