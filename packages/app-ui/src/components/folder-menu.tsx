'use client';

import * as React from 'react';
import { Folder, FolderInput, FolderPlus, Pencil, Star, Trash2, UserPlus } from 'lucide-react';
import {
  useCreateFolder,
  useDeleteFolder,
  useFeatureFlag,
  useFolders,
  useUpdateFolder,
} from '@prismical/app-client';
import type { Folder as FolderModel } from '@prismical/app-contracts';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '../ui/context-menu';
import { FolderNameDialog } from '../shell/folder-name-dialog';
import { DeleteFolderDialog } from '../shell/delete-folder-dialog';
import { ShareDialog } from '../shell/share-dialog';
import { MoveOutOfSharedDialog } from '../shell/move-out-of-shared-dialog';
import { moveLeavesSharedFolder } from '../lib/folder-sharing';
import {
  flattenTree,
  folderMoveTargets,
  MAX_FOLDER_DEPTH,
  type FolderNode,
} from '../lib/folder-tree';
import { useTranslation } from 'react-i18next';

/**
 * The one menu a folder has, wherever you meet it: a sidebar row, a chip on the notes page, the
 * heading of the folder you are in. Share, new subfolder, move, rename, delete, and (where the
 * caller wants it) favorite, with the same ownership and depth checks everywhere.
 *
 * The items are rendered through whichever menu opened them, a dropdown from a button or a
 * context menu from a right-click, via a small kit of that menu's parts.
 */
export interface FolderRef {
  id: string;
  name: string;
}

interface MenuItemProps {
  children?: React.ReactNode;
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  variant?: 'default' | 'destructive';
  className?: string;
  style?: React.CSSProperties;
}

export interface MenuKit {
  Item: React.ComponentType<MenuItemProps>;
  Separator: React.ComponentType<{ className?: string }>;
  Sub: React.ComponentType<{ children?: React.ReactNode }>;
  SubTrigger: React.ComponentType<{ children?: React.ReactNode; className?: string }>;
  SubContent: React.ComponentType<{ children?: React.ReactNode; className?: string }>;
}

export const dropdownMenuKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

export const contextMenuKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

export interface FolderActions {
  /** Open the create dialog for a folder inside `parent`, or at the top level for `null`. */
  createIn: (parent: FolderRef | null) => void;
  rename: (folder: FolderRef) => void;
  /** Open the delete confirmation; `onConfirm` runs as the delete is sent, for any navigation. */
  remove: (folder: FolderRef, onConfirm?: () => void) => void;
  share: (folder: FolderRef) => void;
  move: (id: string, parentId: string | null) => void;
  favorite: (id: string, favorite: boolean) => void;
  /** Render once, near the menus: the dialogs the actions open. */
  dialogs: React.ReactNode;
}

/**
 * The dialogs and mutations behind a folder menu, owned once by the surface that shows the menus
 * (a sidebar, a strip, a heading) rather than by every row in it.
 */
export function useFolderActions(
  options: {
    /** After a folder is created, with its parent; a tree can open the parent so the new row shows. */
    onCreated?: (parentId: string | null) => void;
  } = {}
): FolderActions {
  const { enabled: sharingEnabled } = useFeatureFlag('sharing');
  // A closed create dialog is `undefined`; `null` is a create at the top level.
  const [createIn, setCreateIn] = React.useState<FolderRef | null | undefined>(undefined);
  const [renaming, setRenaming] = React.useState<FolderRef | null>(null);
  const [removing, setRemoving] = React.useState<{
    folder: FolderRef;
    onConfirm?: () => void;
  } | null>(null);
  const [sharing, setSharing] = React.useState<FolderRef | null>(null);
  // A move out of a shared folder takes the team's access with it, so it asks first.
  const [leaving, setLeaving] = React.useState<{ id: string; parentId: string | null } | null>(
    null
  );
  const { data: folders = [] } = useFolders();

  const createFolder = useCreateFolder();
  // Separate mutation instances so a background favorite or move can't gate a dialog's `pending`
  // (which would swallow its Esc/Cancel and trap it open).
  const favoriteFolder = useUpdateFolder();
  const renameFolder = useUpdateFolder();
  const moveFolder = useUpdateFolder();
  const deleteFolder = useDeleteFolder();
  const { onCreated } = options;

  const dialogs = (
    <>
      {sharingEnabled && sharing ? (
        <ShareDialog
          resourceType="folder"
          resourceId={sharing.id}
          resourceTitle={sharing.name}
          open
          onOpenChange={open => !open && setSharing(null)}
        />
      ) : null}
      <FolderNameDialog
        open={createIn !== undefined}
        onOpenChange={open => !open && setCreateIn(undefined)}
        mode="create"
        parentName={createIn?.name}
        pending={createFolder.isPending}
        onSubmit={name => {
          const parentId = createIn?.id ?? null;
          createFolder.mutate(
            { name, parentId },
            {
              onSuccess: () => {
                setCreateIn(undefined);
                onCreated?.(parentId);
              },
            }
          );
        }}
      />
      <FolderNameDialog
        open={renaming !== null}
        onOpenChange={open => !open && setRenaming(null)}
        mode="rename"
        initialName={renaming?.name}
        pending={renameFolder.isPending}
        onSubmit={name => {
          if (!renaming) return;
          renameFolder.mutate(
            { id: renaming.id, patch: { name } },
            { onSuccess: () => setRenaming(null) }
          );
        }}
      />
      <MoveOutOfSharedDialog
        open={leaving !== null}
        what="folder"
        onCancel={() => setLeaving(null)}
        onConfirm={() => {
          if (leaving) moveFolder.mutate({ id: leaving.id, patch: { parentId: leaving.parentId } });
          setLeaving(null);
        }}
      />
      <DeleteFolderDialog
        folder={removing?.folder ?? null}
        pending={deleteFolder.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          removing.onConfirm?.();
          deleteFolder.mutate(removing.folder.id, { onSuccess: () => setRemoving(null) });
        }}
      />
    </>
  );

  return {
    createIn: parent => setCreateIn(parent),
    rename: folder => setRenaming(folder),
    remove: (folder, onConfirm) => setRemoving({ folder, onConfirm }),
    share: folder => setSharing(folder),
    move: (id, parentId) => {
      const from = folders.find(folder => folder.id === id)?.parentId ?? null;
      if (moveLeavesSharedFolder(folders, from, parentId)) {
        setLeaving({ id, parentId });
        return;
      }
      moveFolder.mutate({ id, patch: { parentId } });
    },
    favorite: (id, favorite) => favoriteFolder.mutate({ id, patch: { isFavorite: favorite } }),
    dialogs,
  };
}

interface FolderMenuItemsProps {
  folder: FolderModel;
  /** The whole tree, for the depth cap and the move targets. */
  tree: FolderNode[];
  actions: FolderActions;
  kit: MenuKit;
  /** Lead with the favorite toggle; the sidebar wants it, a chip does not. */
  withFavorite?: boolean;
  /** Runs as a delete is confirmed, before it is sent: the place to leave the folder's own view. */
  onDelete?: () => void;
}

export function FolderMenuItems({
  folder,
  tree,
  actions,
  kit,
  withFavorite = false,
  onDelete,
}: FolderMenuItemsProps) {
  const { t } = useTranslation();
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  const { enabled: sharingEnabled } = useFeatureFlag('sharing');
  const ref: FolderRef = { id: folder.id, name: folder.name };

  const depth = React.useMemo(
    () => flattenTree(tree).find(row => row.node.folder.id === folder.id)?.depth ?? 0,
    [tree, folder.id]
  );
  const { canMoveToRoot, targets } = React.useMemo(
    () => folderMoveTargets(tree, folder.id),
    [tree, folder.id]
  );
  // A folder someone else shared can be looked at and, for a manager, shared on; renaming,
  // moving, deleting and nesting under it stay with its owner, as the server enforces.
  const own = folder.isOwner !== false;
  const showMove = own;
  const leading = withFavorite || sharingEnabled || own;

  // A folder someone else shared, with sharing switched off since: nothing to offer, and an
  // empty menu reads as broken.
  if (!own && !withFavorite && !sharingEnabled) {
    return <Item disabled>{t('folders.noActions')}</Item>;
  }

  return (
    <>
      {withFavorite ? (
        <Item onSelect={() => actions.favorite(folder.id, !folder.favorite)}>
          <Star className="h-4 w-4" />
          <span>
            {folder.favorite
              ? t('navigation.collections.removeFromFavorites')
              : t('navigation.collections.addToFavorites')}
          </span>
        </Item>
      ) : null}
      {sharingEnabled ? (
        <Item onSelect={() => actions.share(ref)}>
          <UserPlus className="h-4 w-4" />
          <span>{t('navigation.collections.shareFolder')}</span>
        </Item>
      ) : null}
      {own ? (
        // Depth is counted in tiers, so a row at the second-to-last tier is the last that can hold
        // one. Disabled rather than hidden past the limit: the item disappearing entirely reads as
        // the feature being missing, not as a limit being reached.
        <Item disabled={depth + 1 >= MAX_FOLDER_DEPTH} onSelect={() => actions.createIn(ref)}>
          <FolderPlus className="h-4 w-4" />
          <span>{t('folders.newSubfolder')}</span>
        </Item>
      ) : null}
      {showMove ? (
        <Sub>
          <SubTrigger>
            <FolderInput className="h-4 w-4" />
            <span>{t('folders.moveTo')}</span>
          </SubTrigger>
          <SubContent className="max-h-72 w-56 overflow-y-auto">
            <Item disabled={!canMoveToRoot} onSelect={() => actions.move(folder.id, null)}>
              <span>{t('folders.moveToRoot')}</span>
            </Item>
            {targets.length === 0 ? (
              <>
                <Separator />
                <Item disabled>{t('folders.noMoveTargets')}</Item>
              </>
            ) : (
              <>
                <Separator />
                {targets.map(target => (
                  <Item
                    key={target.node.folder.id}
                    disabled={target.disabled}
                    onSelect={() => actions.move(folder.id, target.node.folder.id)}
                    style={{ paddingInlineStart: `calc(0.5rem + 0.75rem * ${target.depth})` }}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{target.node.folder.name}</span>
                  </Item>
                ))}
              </>
            )}
          </SubContent>
        </Sub>
      ) : null}
      {own ? (
        <>
          {leading ? <Separator /> : null}
          <Item onSelect={() => actions.rename(ref)}>
            <Pencil className="h-4 w-4" />
            <span>{t('common.actions.rename')}</span>
          </Item>
          <Item variant="destructive" onSelect={() => actions.remove(ref, onDelete)}>
            <Trash2 className="h-4 w-4" />
            <span>{t('common.actions.delete')}</span>
          </Item>
        </>
      ) : null}
    </>
  );
}
