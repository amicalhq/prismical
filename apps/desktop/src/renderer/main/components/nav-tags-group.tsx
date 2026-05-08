import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
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
    <SidebarGroup className="group/tags pt-0 group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className="justify-between">
        <span>{t("settings.sidebar.tags")}</span>
        <Link
          to="/tags"
          aria-label={viewAllLabel}
          className="opacity-0 outline-hidden transition-opacity hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/tags:opacity-100"
        >
          {viewAllLabel} ›
        </Link>
      </SidebarGroupLabel>
      {tags.length === 0 ? (
        <SidebarGroupContent>
          <p className="px-2 py-1 text-xs text-sidebar-foreground/60">
            {t("settings.sidebar.noTags")}
          </p>
        </SidebarGroupContent>
      ) : (
        <SidebarMenu>
          {tags.map((tag) => (
            <TagSidebarRow
              key={`tag-${tag.id}`}
              tag={tag}
              noteCount={noteCountFor(tag.id)}
            />
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
