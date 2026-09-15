import type { Folder as FolderModel } from '@prismical/app-contracts';

// The folder hierarchy, shared by the notes page and the sidebar so the two cannot disagree
// about what is inside what.

/** Key for the synthetic root bucket. Not a folder id: ids are prefixed (`fld_`), so it can't collide. */
const ROOT_KEY = 'root';

export interface FolderNode {
  folder: FolderModel;
  children: FolderNode[];
  /** Notes in this folder AND every folder under it. */
  noteCount: number;
}

const byName = (a: FolderModel, b: FolderModel) => a.name.localeCompare(b.name);

/**
 * Build the tree. Two things a naive `parentId === null` walk gets wrong, both of which would make
 * folders VANISH from the one screen meant to account for all of them:
 *   - an orphan (parent deleted, or not readable by me) is not a root, yet has no reachable parent,
 *     so the root level adopts it;
 *   - a parent cycle is reachable from no root at all, so a sweep after the walk plants whatever the
 *     walk never visited. `seen` is what keeps the recursion finite.
 */
export function buildFolderTree(
  folders: FolderModel[],
  directCount: (id: string) => number
): FolderNode[] {
  const known = new Set(folders.map(folder => folder.id));
  const childrenOf = new Map<string, FolderModel[]>();
  for (const folder of folders) {
    const key = folder.parentId && known.has(folder.parentId) ? folder.parentId : ROOT_KEY;
    const siblings = childrenOf.get(key);
    if (siblings) siblings.push(folder);
    else childrenOf.set(key, [folder]);
  }

  const seen = new Set<string>();
  const node = (folder: FolderModel): FolderNode => {
    seen.add(folder.id);
    const children = build(folder.id);
    return {
      folder,
      children,
      noteCount: children.reduce((sum, child) => sum + child.noteCount, directCount(folder.id)),
    };
  };
  const build = (parentKey: string): FolderNode[] =>
    [...(childrenOf.get(parentKey) ?? [])]
      .sort(byName)
      .filter(folder => !seen.has(folder.id))
      .map(node);

  const roots = build(ROOT_KEY);
  for (const folder of [...folders].sort(byName)) {
    if (!seen.has(folder.id)) roots.push(node(folder));
  }
  return roots;
}

/**
 * How many tiers deep a folder may be CREATED. Three covers what folders are for here
 * (Work / Clients / Acme) and keeps a path short enough to read in a note's folder chip.
 *
 * A limit on the action, not on the data: a tree built through the API or on another client can be
 * deeper, and the walk above renders it — refusing to draw what already exists would hide folders.
 */
export const MAX_FOLDER_DEPTH = 3;

/**
 * The chain from a root down to the folder itself, root first; empty for an id nobody knows. Stops
 * at a parent that is not in the list (a shared folder whose parent was not shared) and at a
 * parent cycle, so the chain is always finite and always starts at something visible.
 */
export function folderAncestry(folders: FolderModel[], id: string): FolderModel[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const chain: FolderModel[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

/** One level of the tree: the roots for `null`, else the named folder's own children. */
export function levelOf(tree: FolderNode[], parentId: string | null): FolderNode[] {
  if (parentId === null) return tree;
  const find = (nodes: FolderNode[]): FolderNode | undefined => {
    for (const node of nodes) {
      if (node.folder.id === parentId) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(tree)?.children ?? [];
}

/** The node for a folder id, wherever it sits in the tree; undefined for an id the tree lacks. */
export function findFolderNode(tree: FolderNode[], id: string): FolderNode | undefined {
  for (const node of tree) {
    if (node.folder.id === id) return node;
    const hit = findFolderNode(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** The whole tree in display order, every branch open, with each row's depth (roots are 0). */
export function flattenTree(nodes: FolderNode[]): { node: FolderNode; depth: number }[] {
  const rows: { node: FolderNode; depth: number }[] = [];
  const walk = (list: FolderNode[], depth: number) => {
    for (const node of list) {
      rows.push({ node, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

/** Every folder inside this one, at any depth: a folder cannot move into its own subtree. */
export function descendantIds(node: FolderNode, out = new Set<string>()): Set<string> {
  for (const child of node.children) {
    out.add(child.folder.id);
    descendantIds(child, out);
  }
  return out;
}

/** How many tiers the subtree adds below its own row, so a move can't push its children past the limit. */
export function subtreeHeight(node: FolderNode): number {
  return node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map(subtreeHeight));
}

export interface MoveTarget {
  node: FolderNode;
  depth: number;
  /** Where the folder already is: listed so the tree reads whole, but not a move. */
  disabled: boolean;
}

/**
 * Where a folder may be moved. Not into itself, not into its own subtree (which would strand the
 * lot), and nowhere that pushes its deepest child past the depth cap: a folder that carries
 * children needs room for them. Its current parent is listed but disabled. The top level is a
 * target too, unless the folder is already there.
 */
export function folderMoveTargets(
  tree: FolderNode[],
  folderId: string
): { canMoveToRoot: boolean; targets: MoveTarget[] } {
  const self = findFolderNode(tree, folderId);
  if (!self) return { canMoveToRoot: false, targets: [] };
  const inside = descendantIds(self);
  const height = subtreeHeight(self);
  const targets = flattenTree(tree)
    .filter(
      ({ node, depth }) =>
        node.folder.id !== folderId &&
        !inside.has(node.folder.id) &&
        depth + 1 + height < MAX_FOLDER_DEPTH
    )
    .map(({ node, depth }) => ({
      node,
      depth,
      disabled: node.folder.id === self.folder.parentId,
    }));
  return { canMoveToRoot: self.folder.parentId !== null, targets };
}
