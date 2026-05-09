import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import NotesPage from "../../pages/notes";

const NotesSearch = z.object({
  // Selected folder id. Omitted means "All notes" (no folder filter).
  // Literal 0 represents "Unfiled" (notes with folder_id IS NULL); 0 is
  // safe because folder ids autoincrement from 1.
  folder: z.number().int().nonnegative().optional(),
  // Active tag filter. Either repeated (`?tags=1&tags=2`) or scalar.
  // Normalized to `number[]` for the page to consume.
  tags: z
    .union([z.array(z.number().int().positive()), z.number().int().positive()])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : Array.isArray(v) ? v : [v],
    ),
  // sort/sortOrder default at the consumer (page reads with ?? "updatedAt"/"desc")
  // rather than via .default() here, so TanStack Router doesn't treat them as
  // required search params at every navigate() call site.
  sort: z.enum(["updatedAt", "createdAt", "title"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

export const Route = createFileRoute("/_app/notes/")({
  validateSearch: (s) => NotesSearch.parse(s),
  component: NotesPage,
});
