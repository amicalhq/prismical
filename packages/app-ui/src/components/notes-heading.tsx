'use client';

import * as React from 'react';
import { ChevronRight, Folder, MoreHorizontal, Star, UserPlus } from 'lucide-react';
import { AppLink as Link } from '../shell/app-link';
import {
  useFeatureFlag,
  useFolderMembers,
  useFolders,
  useNavigation,
  useSearchParams,
} from '@prismical/app-client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Button } from '../ui/button';
import { UserAvatar } from '../ui/user-avatar';
import { AvatarGroup, AvatarGroupCount } from '../ui/avatar';
import { buildFolderTree, folderAncestry } from '../lib/folder-tree';
import { withNotesFolder } from '../lib/notes-filter-url';
import { dropdownMenuKit, FolderMenuItems, useFolderActions } from './folder-menu';
import { SharedFolderIcon } from './folder-chip';
import { isFolderShared } from '../lib/folder-sharing';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

/**
 * The notes page's title, and where the user is. At the root it is the plain page title. Inside a
 * folder it is the path down to it, `Notes › Work › Clients`, each earlier segment a link one
 * level up and the folder itself the heading. The folder is a location, so the heading says so;
 * the toolbar below stays for filters.
 *
 * The folder you are in is also the folder you act on: the last crumb carries the folder's menu
 * (share, new subfolder, move, rename, delete). Deleting it leaves you one level up.
 *
 * Sharing lives on the container, so it shows here: the people with access as an avatar stack
 * that opens the share dialog, a Share button beside it, and for a folder someone else shared,
 * whose it is.
 *
 * A folder the list does not know (still syncing, or gone) falls back to the plain title rather
 * than a heading with a hole in it.
 */
export function NotesHeading({ folderId }: { folderId: string | null }) {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const router = useNavigation();
  const { data: folders = [] } = useFolders();
  const actions = useFolderActions();
  const { enabled: sharingEnabled } = useFeatureFlag('sharing');
  const members = useFolderMembers(sharingEnabled ? folderId : null);
  const chain = React.useMemo(
    () => (folderId ? folderAncestry(folders, folderId) : []),
    [folders, folderId]
  );
  // Counts are not needed here; the tree is for the depth cap and the move targets.
  const tree = React.useMemo(() => buildFolderTree(folders, () => 0), [folders]);

  // One row, the same size in and out of a folder: the title never changes size or position,
  // only its colour, as the crumbs go grey and the folder takes the title's place. Whatever the
  // folder adds (its menu, who has access, Share) sits in the same row, so nothing below moves.
  // The dialogs render in both states: deleting the folder you are in empties the chain on the
  // very next render, and a confirmation torn out mid-close never restores focus or the page.
  const current = chain[chain.length - 1];
  const parent = chain.length > 1 ? chain[chain.length - 2] : undefined;
  // Direct members and the people who reach it through a parent; the owner is not a member.
  // One entry per person: someone on this folder AND on a parent is listed under both by the
  // roster, and must not be counted twice here.
  const people = members.data
    ? [
        ...new Map(
          [...members.data.members, ...members.data.inherited].map(person => [
            person.orgUserId,
            person,
          ])
        ).values(),
      ]
    : [];
  const shown = people.slice(0, 3);
  const canShare = !!current && (current.isOwner !== false || members.data?.canManage === true);
  const crumbs: { id: string | null; name: string }[] = current
    ? [
        { id: null, name: t('notes.list.title') },
        ...chain.slice(0, -1).map(folder => ({ id: folder.id, name: folder.name })),
      ]
    : [];
  // A landmark only when there is a path to land on; the plain title is just the title.
  const Row = current ? 'nav' : 'div';

  return (
    <>
      <Row
        aria-label={current ? t('folders.path') : undefined}
        className="mb-6 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2"
      >
        <ol className="flex min-w-0 flex-wrap items-center gap-1 text-xl font-bold">
          {crumbs.map(crumb => (
            <React.Fragment key={crumb.id ?? 'root'}>
              <li className="min-w-0">
                <Link
                  href={withNotesFolder(searchParams, crumb.id)}
                  className="flex max-w-48 items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {/* Every crumb past the root is a folder, and says so the way a chip does. */}
                  {crumb.id ? <Folder aria-hidden="true" className="size-5 shrink-0" /> : null}
                  <span className="truncate">{crumb.name}</span>
                </Link>
              </li>
              <li aria-hidden="true" className="text-muted-foreground/60">
                <ChevronRight className="size-4" />
              </li>
            </React.Fragment>
          ))}
          <li className="flex min-w-0 items-center gap-1.5">
            {current ? (
              <SharedFolderIcon
                shared={isFolderShared(folders, current.id)}
                className="size-5 shrink-0 text-muted-foreground"
              />
            ) : null}
            <h1 className="truncate">{current ? current.name : t('notes.list.title')}</h1>
          </li>
        </ol>
        {current?.isOwner === false ? (
          <span className="text-sm text-muted-foreground">
            {t('folders.sharedBy', { name: current.sharedByName ?? t('shared.someone') })}
          </span>
        ) : null}
        {current ? (
          // The same cluster the note page carries: who has access, Share, favorite, and the
          // menu, in that order, on the right of the title row.
          <div className="ml-auto flex items-center gap-1">
            {sharingEnabled && people.length > 0 ? (
              <button
                type="button"
                onClick={() => actions.share(current)}
                title={t('folders.sharedWith', { count: people.length })}
                className="mr-1 flex cursor-pointer items-center rounded-full"
              >
                <AvatarGroup>
                  {shown.map(person => (
                    <UserAvatar
                      key={person.orgUserId}
                      name={person.name}
                      email={person.email}
                      image={person.image}
                      size="sm"
                    />
                  ))}
                  {people.length > shown.length ? (
                    <AvatarGroupCount>+{people.length - shown.length}</AvatarGroupCount>
                  ) : null}
                </AvatarGroup>
                <span className="sr-only">{t('folders.sharedWith', { count: people.length })}</span>
              </button>
            ) : null}
            {sharingEnabled && canShare ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => actions.share(current)}
                className="h-8 shrink-0 gap-1.5 px-2 hover:bg-accent"
                aria-label={t('navigation.collections.shareFolder')}
              >
                <UserPlus className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('common.actions.share')}</span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => actions.favorite(current.id, !current.favorite)}
              className="h-8 w-8 shrink-0 p-0 hover:bg-accent"
              aria-label={
                current.favorite
                  ? t('navigation.collections.removeFromFavorites')
                  : t('navigation.collections.addToFavorites')
              }
            >
              <Star
                className={cn(
                  'size-4 transition-colors',
                  current.favorite ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'
                )}
              />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0 hover:bg-accent"
                  aria-label={t('folders.options', { name: current.name })}
                >
                  <MoreHorizontal className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              {/* Sized to its longest label - see the note on the tag row's menu. */}
              <DropdownMenuContent align="end" className="w-max max-w-72 min-w-48 rounded-lg">
                <FolderMenuItems
                  folder={current}
                  tree={tree}
                  actions={actions}
                  kit={dropdownMenuKit}
                  onDelete={() => router.replace(withNotesFolder(searchParams, parent?.id ?? null))}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </Row>
      {actions.dialogs}
    </>
  );
}
