import { useState } from "react";
import { Link } from "@tanstack/react-router";
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
      <SidebarMenuItem className="group/tag-item relative">
        <SidebarMenuButton asChild>
          <Link
            to="/notes"
            search={{ tag: tag.id }}
            aria-label={`#${tag.name}`}
          >
            <TagHash color={tag.color} name={tag.name} />
          </Link>
        </SidebarMenuButton>
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover/tag-item:opacity-100">
          <TagRowMenu
            tag={tag}
            onEdit={() => setEditing(true)}
            onDelete={() => setConfirming(true)}
          />
        </div>
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
