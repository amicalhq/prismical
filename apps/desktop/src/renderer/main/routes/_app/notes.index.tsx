import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import NotesPage from "../../pages/notes";

const NotesSearch = z.object({
  tag: z.number().int().optional(),
});

export const Route = createFileRoute("/_app/notes/")({
  validateSearch: (s) => NotesSearch.parse(s),
  component: NotesPage,
});
