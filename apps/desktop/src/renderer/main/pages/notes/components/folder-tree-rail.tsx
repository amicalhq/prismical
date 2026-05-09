import * as React from "react";
import { Plus } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CreateFolderDialog } from "@/renderer/main/components/create-folder-dialog";
import { api } from "@/trpc/react";
import type { Folder as FolderRecord } from "@/db/schema";
import { FolderTreeRow, type FolderTreeNode } from "./folder-tree-row";

type FlatFolder = FolderRecord & { noteCount: number };

function buildTree(flat: FlatFolder[]): FolderTreeNode[] {
  const byId = new Map<number, FolderTreeNode>();
  flat.forEach((f) => byId.set(f.id, { ...f, children: [] }));
  const roots: FolderTreeNode[] = [];
  byId.forEach((node) => {
    if (node.parentId !== null && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortByName = (nodes: FolderTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortByName(n.children));
  };
  sortByName(roots);
  return roots;
}

export function FolderTreeRail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { folder?: number };
  const selected = search.folder ?? null;

  const treeQ = api.folders.tree.useQuery();
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const [creating, setCreating] = React.useState(false);

  const tree = React.useMemo(
    () => buildTree(treeQ.data?.folders ?? []),
    [treeQ.data?.folders],
  );

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectFolder = (id: number) => {
    navigate({
      to: "/notes",
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        folder: prev?.folder === id ? undefined : id,
      })) as never,
    });
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings.sidebar.folders")}
        </span>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          aria-label={t("settings.folders.actions.create")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="rounded-xl bg-accent/40 p-2 dark:bg-accent/30">
        {tree.map((node) => (
          <FolderTreeRow
            key={node.id}
            node={node}
            level={0}
            selectedId={selected}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onSelect={selectFolder}
          />
        ))}

        {tree.length === 0 && treeQ.data && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            {t("settings.sidebar.noFolders")}
          </div>
        )}
      </div>

      <CreateFolderDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
