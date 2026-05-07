import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Tag as TagIcon } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/trpc/react";
import { TagHash } from "./tag/tag-hash";
import { TagRowMenu } from "./tag/tag-row-menu";
import { TagEditDialog } from "./tag/tag-edit-dialog";
import type { Tag } from "@/db/schema";
import { useTranslation } from "react-i18next";

const RECENT_LIMIT = 5;

export function NavTagsGroup() {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const recent = api.tags.listRecent.useQuery({ limit: RECENT_LIMIT });
  const counts = api.tags.listWithCounts.useQuery({ sortBy: "createdAt" });
  const [editing, setEditing] = useState<Tag | null>(null);
  const [confirming, setConfirming] = useState<Tag | null>(null);
  const del = api.tags.delete.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      setConfirming(null);
    },
  });

  const tags = recent.data ?? [];
  const noteCountFor = (tagId: number) =>
    counts.data?.find((c) => c.id === tagId)?.noteCount ?? 0;

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>{t("settings.sidebar.tags")}</SidebarGroupLabel>
        <SidebarMenu>
          {tags.length === 0 ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled
                className="text-sidebar-foreground/60"
              >
                <TagIcon className="size-4" />
                <span>{t("settings.sidebar.noTags")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : (
            tags.map((tag) => (
              <SidebarMenuItem
                key={`tag-${tag.id}`}
                className="group/tag-item relative"
              >
                <SidebarMenuButton asChild>
                  <Link
                    to="/settings/notes"
                    search={{ tag: tag.id }}
                    aria-label={`#${tag.name}`}
                  >
                    <TagHash color={tag.color} name={tag.name} />
                  </Link>
                </SidebarMenuButton>
                <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/tag-item:opacity-100">
                  <TagRowMenu
                    tag={tag}
                    onEdit={() => setEditing(tag)}
                    onDelete={() => setConfirming(tag)}
                  />
                </div>
              </SidebarMenuItem>
            ))
          )}

          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="text-xs text-sidebar-foreground/70"
            >
              <Link to="/settings/tags">
                {t("settings.sidebar.tagsViewAll")} →
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      {editing && (
        <TagEditDialog
          tag={editing}
          noteCount={noteCountFor(editing.id)}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tags.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tags.deleteConfirmDescription", {
                count: confirming ? noteCountFor(confirming.id) : 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.notes.note.deleteDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && del.mutate({ id: confirming.id })}
              className="bg-destructive text-foreground hover:bg-destructive/90"
            >
              {t("settings.notes.note.actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
