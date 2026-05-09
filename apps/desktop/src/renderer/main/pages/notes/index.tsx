import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "@/trpc/react";
import { NotesList } from "./components/notes-list";
import { NotesSearchButton } from "./components/notes-search-button";
import { TagFilterBar } from "./components/tag-filter-bar";
import { SortMenu } from "./components/sort-menu";
import { FolderTreeRail } from "./components/folder-tree-rail";

const UNFILED = 0;

type Sort = "updatedAt" | "createdAt" | "title";
type SortOrder = "asc" | "desc";

export default function Notes() {
  const { t } = useTranslation();
  const search = useSearch({ strict: false }) as {
    folder?: number;
    tags?: number[];
    sort?: Sort;
    sortOrder?: SortOrder;
  };

  const folderId = search.folder ?? null;
  const tagIds = search.tags ?? [];

  // Fetch the folder tree once so we can compute the recursive subtree of
  // the selected folder client-side.
  const treeQ = api.folders.tree.useQuery();

  // Compute the subtree ids for `folderId` (a real folder, not null/UNFILED).
  // Returns null when no folder filter applies (All notes / Unfiled).
  const subtreeIds = (() => {
    if (folderId === null || folderId === UNFILED) return null;
    const flat = treeQ.data?.folders ?? [];
    const childrenOf = new Map<number, number[]>();
    for (const f of flat) {
      if (f.parentId !== null) {
        const arr = childrenOf.get(f.parentId) ?? [];
        arr.push(f.id);
        childrenOf.set(f.parentId, arr);
      }
    }
    const out: number[] = [];
    const stack = [folderId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      const kids = childrenOf.get(id);
      if (kids) stack.push(...kids);
    }
    return out;
  })();

  const folderName = (() => {
    if (folderId === UNFILED) return t("settings.notes.unfiled.label");
    if (folderId === null) return t("settings.notes.scope.all");
    return (
      treeQ.data?.folders.find((f) => f.id === folderId)?.name ??
      t("settings.notes.scope.all")
    );
  })();

  return (
    <div className="mx-auto w-full max-w-6xl px-9 pt-7 pb-8">
      <h1 className="mb-6 text-xl font-bold">
        {t("settings.nav.notes.title")}
      </h1>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <NotesSearchButton />
        <TagFilterBar />
        <div className="ml-auto">
          <SortMenu />
        </div>
      </div>

      <div className="grid grid-cols-[240px_1fr] gap-7">
        <FolderTreeRail />
        <div>
          <p className="mb-2 px-1 text-sm text-muted-foreground">
            {folderName}
            {tagIds.length > 0 && (
              <>
                {" · "}
                {tagIds.length} {t("settings.notes.scope.tagsSuffix")}
              </>
            )}
          </p>
          <NotesList
            showPageHeader={false}
            folderIds={subtreeIds ?? undefined}
            unfiled={folderId === UNFILED}
            tagIds={tagIds.length > 0 ? tagIds : undefined}
            sortBy={search.sort ?? "updatedAt"}
            sortOrder={search.sortOrder ?? "desc"}
          />
        </div>
      </div>
    </div>
  );
}
