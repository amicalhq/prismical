import { NotebookText, X } from "lucide-react";
import { NoteCard } from "./note-card";
import { api } from "@/trpc/react";
import { Skeleton } from "@/components/ui/skeleton";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import type { Note } from "../types";
import { TagHash } from "@/renderer/main/components/tag/tag-hash";

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
  const search = useSearch({ strict: false });
  const tagId = (search as { tag?: number }).tag;

  const { data: notes, isLoading } = api.notes.getNotes.useQuery({
    sortBy: "updatedAt",
    sortOrder: "desc",
    tagId,
  });

  const filterTagQ = api.tags.getById.useQuery(
    { id: tagId! },
    { enabled: tagId !== undefined },
  );

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
                <NoteCard key={note.id} note={note} onNoteClick={onNoteClick} />
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  const clearFilter = () => navigate({ to: "/settings/notes", search: {} });

  const filterBanner =
    tagId !== undefined && filterTagQ.data ? (
      <div className="mb-3 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          {t("settings.tags.filterBanner.label")}
        </span>
        <TagHash color={filterTagQ.data.color} name={filterTagQ.data.name} />
        <span className="text-xs text-muted-foreground">
          ({notes?.length ?? 0})
        </span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={clearFilter}
        >
          {t("settings.tags.filterBanner.clear")} <X className="h-3 w-3" />
        </button>
      </div>
    ) : null;

  return (
    <div>
      {showPageHeader ? (
        <div className="mb-8">
          <h1 className="text-xl font-bold">{t("settings.nav.notes.title")}</h1>
        </div>
      ) : null}

      {filterBanner}

      {formattedNotes.length > 0 && (
        <div>
          {formattedNotes.map((note) => (
            <NoteCard key={note.id} note={note} onNoteClick={onNoteClick} />
          ))}
        </div>
      )}

      {formattedNotes.length === 0 &&
        (tagId !== undefined && filterTagQ.data ? (
          <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
            <NotebookText className="w-8 h-8 text-muted-foreground mx-auto" />
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t("settings.tags.emptyFiltered.title", {
                  name: filterTagQ.data.name,
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings.tags.emptyFiltered.description")}
              </p>
            </div>
            <button
              type="button"
              onClick={clearFilter}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("settings.tags.filterBanner.clear")}
            </button>
          </div>
        ) : (
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
        ))}
    </div>
  );
}
