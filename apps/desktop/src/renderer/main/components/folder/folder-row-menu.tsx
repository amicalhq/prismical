import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { api } from "@/trpc/react";
import type { Folder } from "@/db/schema";

export function FolderRowMenu({
  folder,
  onRename,
  onDelete,
}: {
  folder: Folder;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const utils = api.useUtils();

  const updateMutation = api.folders.update.useMutation({
    onSuccess: () => utils.folders.invalidate(),
    onError: (error) => toast.error(error.message),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction showOnHover>
          <MoreHorizontal />
          <span className="sr-only">More</span>
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56 rounded-lg" align="start">
        {folder.isFavorite ? (
          <DropdownMenuItem
            onSelect={() =>
              updateMutation.mutate({ id: folder.id, isFavorite: false })
            }
          >
            <StarOff />
            <span>{t("settings.notes.folder.actions.removeFromFavorites")}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() =>
              updateMutation.mutate({ id: folder.id, isFavorite: true })
            }
          >
            <Star />
            <span>{t("settings.notes.folder.actions.addToFavorites")}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onRename}>
          <Pencil />
          <span>{t("settings.notes.folder.actions.rename")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          <span>{t("settings.notes.folder.actions.delete")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
