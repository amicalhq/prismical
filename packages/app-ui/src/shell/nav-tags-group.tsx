'use client';

import { useMemo, useState } from 'react';
import { AppLink as Link } from './app-link';
import { ChevronRight, Plus } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '../ui/sidebar';
import { TagSidebarRow } from './tag-sidebar-row';
import { TagEditDialog } from './tag-edit-dialog';
import { recentPlusCurrent } from '../lib/sidebar-recent';
import {
  nextAutoColor,
  useCreateTag,
  usePathname,
  useSearchParams,
  useTags,
} from '@prismical/app-client';
import { useAllNoteTags } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

const RECENT_LIMIT = 5;

export function NavTagsGroup() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tagsQ = useTags();
  const noteTagsQ = useAllNoteTags();
  // Memoized so the `?? []` fallback doesn't hand the derivations below a fresh array every render
  // (`data` is undefined until the first pull lands).
  const allTags = useMemo(() => tagsQ.data ?? [], [tagsQ.data]);
  const noteTags = noteTagsQ.data ?? [];
  // First load: skeleton rows, not the empty state — "no tags" and "not loaded yet" are different.
  const loading = tagsQ.isLoading || noteTagsQ.isLoading;
  // And a FAILED pull is a third thing again: `listResult` reports isLoading false with data
  // undefined, so without this the group would tell someone with thirty tags they have none and
  // offer to make one. Creating against that empty view mints a colliding tag the server then
  // rejects, losing the color they picked. The tags query is the authority here — noteTags only
  // supplies the counts.
  const failed = Boolean(tagsQ.error);
  // The newest few, plus whichever tags the note list is filtered to — the rest live on /tags.
  const activeTagIds = pathname === '/notes' ? searchParams.getAll('tags') : [];
  const tags = recentPlusCurrent(allTags, RECENT_LIMIT, activeTagIds);
  const [open, setOpen] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const createTag = useCreateTag();

  // Seeded the same way the tags index seeds it, so a tag created here lands on the same palette
  // step it would have had from that screen or from typing the name on a note.
  const suggestedColor = useMemo(() => nextAutoColor(allTags.map(tag => tag.color)), [allTags]);
  const takenNames = useMemo(() => allTags.map(tag => tag.name), [allTags]);

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
          ) : failed ? null : tags.length === 0 ? (
            // A row, not the "No tags" line it replaces: tags are otherwise created from a note or
            // from /tags, so an empty group was a dead end that only said so.
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  className="text-sidebar-foreground-muted"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" />
                  <span>{t('navigation.collections.createTag')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          ) : (
            <SidebarMenu>
              {tags.map(tag => (
                <TagSidebarRow
                  key={`tag-${tag.id}`}
                  tag={tag}
                  tagNames={takenNames}
                  noteCount={countByTag.get(tag.id) ?? 0}
                />
              ))}
            </SidebarMenu>
          )}
        </CollapsibleContent>
      </SidebarGroup>

      <TagEditDialog
        open={createOpen}
        mode="create"
        onOpenChange={setCreateOpen}
        defaultColor={suggestedColor}
        takenNames={takenNames}
        pending={createTag.isPending}
        onSubmit={values => {
          if (!values.name) return;
          createTag.mutate(
            { name: values.name, color: values.color },
            { onSuccess: () => setCreateOpen(false) }
          );
        }}
      />
    </Collapsible>
  );
}
