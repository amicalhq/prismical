import { MoreHorizontal, Star, StarOff, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Tag } from "@/db/schema";
import { api } from "@/trpc/react";

interface TagRowMenuProps {
  tag: Tag;
  onEdit: () => void;
  onDelete?: () => void;
  triggerClassName?: string;
}

export function TagRowMenu({
  tag,
  onEdit,
  onDelete,
  triggerClassName,
}: TagRowMenuProps) {
  const { t } = useTranslation();
  const utils = api.useUtils();
  const update = api.tags.update.useMutation({
    onSuccess: () => utils.tags.invalidate(),
    onError: (error) => {
      toast.error(
        t("settings.tags.errors.favoriteFailed", { message: error.message }),
      );
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`#${tag.name}`}
          className={
            triggerClassName ??
            "rounded p-1 text-muted-foreground hover:bg-muted"
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {tag.isFavorite ? (
          <DropdownMenuItem
            onSelect={() => update.mutate({ id: tag.id, isFavorite: false })}
          >
            <StarOff className="mr-2 h-4 w-4" />{" "}
            {t("settings.tags.menu.unfavorite")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => update.mutate({ id: tag.id, isFavorite: true })}
          >
            <Star className="mr-2 h-4 w-4" />{" "}
            {t("settings.tags.menu.favorite")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="mr-2 h-4 w-4" /> {t("settings.tags.menu.edit")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete ?? onEdit}>
          <Trash2 className="mr-2 h-4 w-4" /> {t("settings.tags.menu.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
