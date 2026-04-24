import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCreateNoteAction } from "./create-note-context";

export function HeaderCreateNoteButton() {
  const { t } = useTranslation();
  const { createNote, isPending, shortcutDisplay } = useCreateNoteAction();
  const label = t("settings.notes.sidebarButtonLabel");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          className="h-7 gap-1.5 px-2.5"
          onClick={createNote}
          disabled={isPending}
          aria-label={label}
        >
          <Plus className="h-4 w-4" />
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          {shortcutDisplay}
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}
