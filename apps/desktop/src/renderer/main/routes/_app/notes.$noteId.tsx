import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import NotePage from "../../pages/notes/components/note-wrapper";
import { recordNoteVisit } from "../../lib/recent-notes";

const booleanSearchParam = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return undefined;
}, z.boolean().optional());

const noteSearchSchema = z.object({
  autoRecord: booleanSearchParam,
  openTranscription: booleanSearchParam,
});

export const Route = createFileRoute("/_app/notes/$noteId")({
  component: NotePageWrapper,
  validateSearch: noteSearchSchema,
});

function NotePageWrapper() {
  const { noteId } = Route.useParams();
  const { autoRecord, openTranscription } = Route.useSearch();

  useEffect(() => {
    const numericId = Number(noteId);
    if (Number.isFinite(numericId)) {
      recordNoteVisit(numericId);
    }
  }, [noteId]);

  return (
    <NotePage
      key={noteId}
      noteId={noteId}
      autoRecord={autoRecord}
      openTranscription={openTranscription}
    />
  );
}
