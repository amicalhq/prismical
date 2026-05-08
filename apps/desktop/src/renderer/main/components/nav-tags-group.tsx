import { Link } from "@tanstack/react-router";
import { ArrowRight, Tag as TagIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { api } from "@/trpc/react";
import { TagSidebarRow } from "./tag/tag-sidebar-row";

const RECENT_LIMIT = 5;

export function NavTagsGroup() {
  const { t } = useTranslation();
  const recent = api.tags.listRecent.useQuery({ limit: RECENT_LIMIT });
  const counts = api.tags.listWithCounts.useQuery({ sortBy: "createdAt" });

  const tags = recent.data ?? [];
  const noteCountFor = (tagId: number) =>
    counts.data?.find((c) => c.id === tagId)?.noteCount ?? 0;
  const viewAllLabel = t("settings.sidebar.tagsViewAll");

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{t("settings.sidebar.tags")}</SidebarGroupLabel>
      <SidebarGroupAction asChild title={viewAllLabel}>
        <Link to="/tags" aria-label={viewAllLabel}>
          <ArrowRight />
        </Link>
      </SidebarGroupAction>
      <SidebarMenu>
        {tags.length === 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton disabled className="text-sidebar-foreground/60">
              <TagIcon className="size-4" />
              <span>{t("settings.sidebar.noTags")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          tags.map((tag) => (
            <TagSidebarRow
              key={`tag-${tag.id}`}
              tag={tag}
              noteCount={noteCountFor(tag.id)}
            />
          ))
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
