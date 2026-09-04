'use client';

import { useState } from 'react';
import { AppLink as Link } from './app-link';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '../ui/sidebar';
import { TagSidebarRow } from './tag-sidebar-row';
import { useTags } from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

const RECENT_LIMIT = 5;

export function NavTagsGroup() {
  const { t } = useTranslation();
  const tagsQ = useTags();
  const noteTagsQ = useAllNoteTags();
  const allTags = tagsQ.data ?? [];
  const noteTags = noteTagsQ.data ?? [];
  // First load: skeleton rows, not the "No tags" empty state.
  const loading = tagsQ.isLoading || noteTagsQ.isLoading;
  // Newest-first before the slice: the /me sync lane hands rows back oldest-first, so slicing
  // straight off `allTags` would pin this group to the 5 tags created longest ago and never
  // surface a new one.
  const tags = [...allTags]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, RECENT_LIMIT);
  const [open, setOpen] = useState(true);

  const countByTag = new Map<string, number>();
  for (const { tagId } of noteTags) countByTag.set(tagId, (countByTag.get(tagId) ?? 0) + 1);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/tags-collapsible">
      <SidebarGroup className="group/tags pt-0 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel
          asChild
          className="cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <CollapsibleTrigger>
            <span>{t('navigation.collections.tags')}</span>
            <ChevronRight className="size-3 transition-transform group-data-[state=open]/tags-collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <SidebarGroupAction
          asChild
          className="top-1.5 right-2 aspect-auto h-5 w-auto px-1.5 text-xs font-medium text-sidebar-foreground-muted hover:text-sidebar-foreground opacity-0 transition-opacity after:hidden focus-visible:opacity-100 group-hover/tags:opacity-100"
        >
          <Link href="/notes" aria-label={t('navigation.collections.viewAllTags')}>
            {t('navigation.collections.viewAll')}
          </Link>
        </SidebarGroupAction>
        <CollapsibleContent>
          {loading ? (
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            </SidebarMenu>
          ) : tags.length === 0 ? (
            <SidebarGroupContent>
              <p className="px-2 py-1 text-xs text-sidebar-foreground-muted">
                {t('navigation.collections.noTags')}
              </p>
            </SidebarGroupContent>
          ) : (
            <SidebarMenu>
              {tags.map(tag => (
                <TagSidebarRow
                  key={`tag-${tag.id}`}
                  tag={tag}
                  noteCount={countByTag.get(tag.id) ?? 0}
                />
              ))}
            </SidebarMenu>
          )}
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}
