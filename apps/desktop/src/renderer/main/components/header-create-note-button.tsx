import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useCreateNoteAction } from "./create-note-context";

export function HeaderCreateNoteButton() {
  const { t } = useTranslation();
  const { createNote, isPending } = useCreateNoteAction();
  const label = t("settings.notes.sidebarButtonLabel");

  return (
    <Button
      variant="secondary"
      size="sm"
      className="h-7 gap-1.5 px-2.5"
      onClick={createNote}
      disabled={isPending}
      aria-label={label}
    >
      <Plus className="h-4 w-4" />
      <span>{label}</span>
    </Button>
  );
}
