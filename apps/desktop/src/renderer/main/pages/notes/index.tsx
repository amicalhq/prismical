import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "@/trpc/react";
import { NotesList } from "./components/notes-list";
import { NotesSearchButton } from "./components/notes-search-button";
import { FolderPicker } from "./components/folder-picker";
import { TagFilterBar } from "./components/tag-filter-bar";
import { SortMenu } from "./components/sort-menu";

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

  // Subtree ids for `folderId`. Returns null when no folder filter applies
  // (= "All notes", show everything).
  const subtreeIds = (() => {
    if (folderId === null) return null;
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

  return (
    <div className="mx-auto w-full max-w-6xl px-9 pt-7 pb-8">
      <h1 className="mb-6 text-xl font-bold">
        {t("settings.nav.notes.title")}
      </h1>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <NotesSearchButton />
        <FolderPicker />
        <TagFilterBar />
        <SortMenu />
      </div>

      <NotesList
        showPageHeader={false}
        folderIds={subtreeIds ?? undefined}
        tagIds={tagIds.length > 0 ? tagIds : undefined}
        sortBy={search.sort ?? "updatedAt"}
        sortOrder={search.sortOrder ?? "desc"}
      />
    </div>
  );
}
