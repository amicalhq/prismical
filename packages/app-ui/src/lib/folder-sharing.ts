import type { Folder as FolderModel } from '@prismical/app-contracts';
import { folderAncestry } from './folder-tree';

/**
 * Whether a folder is shared, as the UI means it: it has people on it, or it came from someone
 * else, or any folder above it does, since access follows the tree down. Answered from the folder
 * rows the client already holds, so every chip and row can carry the signal without a request.
 */
export function isFolderShared(folders: FolderModel[], id: string): boolean {
  return folderAncestry(folders, id).some(
    folder => folder.isOwner === false || (folder.memberCount ?? 0) > 0
  );
}

/**
 * Whether a move takes something out of a shared folder into one that is not shared, which
 * takes the team's access away with it. `null` is the top level, which is never shared.
 */
export function moveLeavesSharedFolder(
  folders: FolderModel[],
  fromFolderId: string | null,
  toFolderId: string | null
): boolean {
  const fromShared = fromFolderId ? isFolderShared(folders, fromFolderId) : false;
  const toShared = toFolderId ? isFolderShared(folders, toFolderId) : false;
  return fromShared && !toShared;
}
