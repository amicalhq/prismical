'use client';

import * as React from 'react';
import { AppLink as Link } from './app-link';
import { usePathname, useSearchParams } from '@prismical/app-client';
import { MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { SidebarMenuButton, SidebarMenuItem } from '../ui/sidebar';
import { TagHash } from './tag-chip';
import { TagEditDialog } from './tag-edit-dialog';
import { DeleteTagDialog } from './delete-tag-dialog';
import { useUpdateTag, useDeleteTag } from '@prismical/app-client';
import type { Tag } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';

interface TagSidebarRowProps {
  tag: Tag;
  noteCount: number;
}

export function TagSidebarRow({ tag, noteCount }: TagSidebarRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isActive = pathname === '/notes' && searchParams.getAll('tags').includes(tag.id);

  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  // Separate instances so a background favorite-toggle can't gate the edit dialog's `pending`.
  const favoriteTag = useUpdateTag();
  const editTag = useUpdateTag();
  const deleteTag = useDeleteTag();

  return (
    <SidebarMenuItem className="group/tag-item">
      <SidebarMenuButton
        asChild
        size="sm"
        isActive={isActive}
        className="pr-8 text-sm text-sidebar-foreground"
      >
        <Link href={`/notes?tags=${tag.id}`} aria-label={`#${tag.name}`}>
          <TagHash color={tag.color} name={tag.name} />
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('navigation.collections.noteOptions', { title: tag.name })}
            className="absolute right-1 top-1/2 flex aspect-square w-7 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground opacity-0 outline-hidden transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-focus-within/tag-item:opacity-100 group-hover/tag-item:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-48 rounded-lg" side="right" align="start">
          <DropdownMenuItem
            onSelect={() =>
              favoriteTag.mutate({ id: tag.id, patch: { isFavorite: !tag.favorite } })
            }
          >
            <Star className="h-4 w-4" />
            <span>
              {tag.favorite
                ? t('navigation.collections.removeFromFavorites')
                : t('navigation.collections.addToFavorites')}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4" />
            <span>{t('dialogs.tag.title')}</span>
            <span className="ml-auto text-xs text-muted-foreground">{noteCount}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4" />
            <span>{t('common.actions.delete')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TagEditDialog
        tag={editOpen ? tag : null}
        onOpenChange={setEditOpen}
        pending={editTag.isPending}
        onSubmit={patch =>
          editTag.mutate({ id: tag.id, patch }, { onSuccess: () => setEditOpen(false) })
        }
      />

      <DeleteTagDialog
        tag={deleteOpen ? { id: tag.id, name: tag.name } : null}
        pending={deleteTag.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteTag.mutate(tag.id, { onSuccess: () => setDeleteOpen(false) })}
      />
    </SidebarMenuItem>
  );
}
