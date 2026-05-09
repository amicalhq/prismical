import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { useLocalStorageBoolean } from "@/hooks/useLocalStorageBoolean";
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

  const [open, setOpen] = useLocalStorageBoolean("sidebar:tags:open", true);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/tags-collapsible"
    >
      <SidebarGroup className="group/tags pt-0 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel
          asChild
          className="cursor-pointer gap-1 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <CollapsibleTrigger>
            <span>{t("settings.sidebar.tags")}</span>
            <ChevronRight className="size-3 transition-transform group-data-[state=open]/tags-collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <SidebarGroupAction
          asChild
          className="top-1.5 right-2 aspect-auto h-5 w-auto px-1.5 text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground opacity-0 transition-opacity after:hidden focus-visible:opacity-100 group-hover/tags:opacity-100"
        >
          <Link to="/notes" search={{}} aria-label={viewAllLabel}>
            {viewAllLabel} ›
          </Link>
        </SidebarGroupAction>
        <CollapsibleContent>
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
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}
