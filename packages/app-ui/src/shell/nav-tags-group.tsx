'use client';

import { useMemo, useState } from 'react';
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
import { recentPlusCurrent } from '../lib/sidebar-recent';
import { usePathname, useSearchParams, useTags } from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

const RECENT_LIMIT = 5;

export function NavTagsGroup() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tagsQ = useTags();
  const noteTagsQ = useAllNoteTags();
  const allTags = tagsQ.data ?? [];
  const tagNames = useMemo(() => (tagsQ.data ?? []).map(tag => tag.name), [tagsQ.data]);
  const noteTags = noteTagsQ.data ?? [];
  // First load: skeleton rows, not the "No tags" empty state.
  const loading = tagsQ.isLoading || noteTagsQ.isLoading;
  // The newest few, plus whichever tags the note list is filtered to — the rest live on /tags.
  const activeTagIds = pathname === '/notes' ? searchParams.getAll('tags') : [];
  const tags = recentPlusCurrent(allTags, RECENT_LIMIT, activeTagIds);
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
          <Link href="/tags" aria-label={t('navigation.collections.viewAllTags')}>
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
                  tagNames={tagNames}
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
