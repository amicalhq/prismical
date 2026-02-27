import { NotebookText } from "lucide-react";
import { NoteCard } from "./note-card";
import { api } from "@/trpc/react";
import { Skeleton } from "@/components/ui/skeleton";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import type { Note } from "../types";

interface NotesListProps {
  showPageHeader?: boolean;
  groupByDate?: boolean;
}

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

export function NotesList({
  showPageHeader = true,
  groupByDate = false,
}: NotesListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: notes, isLoading } = api.notes.getNotes.useQuery({
    sortBy: "updatedAt",
    sortOrder: "desc",
  });

  const onNoteClick = (noteId: number) => {
    navigate({
      to: "/settings/notes/$noteId",
      params: { noteId: String(noteId) },
      search: {}, // Clear search params to prevent autoRecord from persisting
    });
  };

  // Convert database notes to UI format
  const formattedNotes = useMemo(() => notes || [], [notes]);

  const { todayNotes, earlierNotes } = useMemo(() => {
    if (!groupByDate) return { todayNotes: [], earlierNotes: [] };
    const today: Note[] = [];
    const earlier: Note[] = [];
    for (const note of formattedNotes) {
      if (isToday(new Date(note.updatedAt))) {
        today.push(note);
      } else {
        earlier.push(note);
      }
    }
    return { todayNotes: today, earlierNotes: earlier };
  }, [formattedNotes, groupByDate]);

  // Loading state
  if (isLoading) {
    return (
      <div>
        {showPageHeader ? (
          <div className="mb-8">
            <h1 className="text-xl font-bold">
              {t("settings.nav.notes.title")}
            </h1>
          </div>
        ) : null}
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3 py-2 px-3">
              <Skeleton className="w-5 h-5 mt-0.5" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (groupByDate) {
    if (formattedNotes.length === 0) {
      return (
        <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
          <NotebookText className="w-8 h-8 text-muted-foreground mx-auto" />
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("settings.notes.empty.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.notes.empty.description")}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        {todayNotes.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground px-3">
              {t("settings.home.notes.today")}
            </h2>
            <div>
              {todayNotes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onNoteClick={onNoteClick}
                  showTimeOnly
                />
              ))}
            </div>
          </section>
        )}
        {earlierNotes.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground px-3">
              {t("settings.home.notes.earlier")}
            </h2>
            <div>
              {earlierNotes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  onNoteClick={onNoteClick}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  return (
    <div>
      {showPageHeader ? (
        <div className="mb-8">
          <h1 className="text-xl font-bold">{t("settings.nav.notes.title")}</h1>
        </div>
      ) : null}

      {formattedNotes.length > 0 && (
        <div>
          {formattedNotes.map((note) => (
            <NoteCard key={note.id} note={note} onNoteClick={onNoteClick} />
          ))}
        </div>
      )}

      {formattedNotes.length === 0 && (
        <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
          <NotebookText className="w-8 h-8 text-muted-foreground mx-auto" />
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("settings.notes.empty.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.notes.empty.description")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
