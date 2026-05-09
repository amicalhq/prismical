import { useState } from "react";
import { Link, useLocation, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { api } from "@/trpc/react";
import type { Tag } from "@/db/schema";
import { TagHash } from "./tag-hash";
import { TagRowMenu } from "./tag-row-menu";
import { TagEditDialog } from "./tag-edit-dialog";

interface TagSidebarRowProps {
  tag: Tag;
  noteCount: number;
}

export function TagSidebarRow({ tag, noteCount }: TagSidebarRowProps) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const location = useLocation();
  const search = useSearch({ strict: false }) as { tags?: number[] };
  const isActive =
    location.pathname === "/notes" && (search.tags ?? []).includes(tag.id);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const del = api.tags.delete.useMutation({
    onSuccess: () => {
      utils.tags.invalidate();
      utils.notes.getNotes.invalidate();
      setConfirming(false);
    },
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.deleteFailed", { message: error.message }),
      );
    },
  });

  return (
    <>
      <SidebarMenuItem className="group/tag-item">
        <SidebarMenuButton asChild isActive={isActive} className="pr-8">
          <Link
            to="/notes"
            search={{ tags: [tag.id] }}
            aria-label={`#${tag.name}`}
          >
            <TagHash color={tag.color} name={tag.name} />
          </Link>
        </SidebarMenuButton>
        <TagRowMenu
          tag={tag}
          onEdit={() => setEditing(true)}
          onDelete={() => setConfirming(true)}
          triggerClassName="absolute right-1 top-1/2 flex aspect-square w-7 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/70 opacity-0 outline-hidden transition-opacity hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-focus-within/tag-item:opacity-100 group-hover/tag-item:opacity-100 data-[state=open]:opacity-100"
        />
      </SidebarMenuItem>

      {editing && (
        <TagEditDialog
          tag={tag}
          noteCount={noteCount}
          open={editing}
          onOpenChange={setEditing}
        />
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.tags.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.tags.deleteConfirmDescription", { count: noteCount })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.tags.editDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => del.mutate({ id: tag.id })}
              className="bg-destructive text-foreground hover:bg-destructive/90"
            >
              {t("settings.tags.menu.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
