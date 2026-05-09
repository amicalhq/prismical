import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

// Legacy /folders route. Replaced by the unified /notes browser in PRSM-30.
// Kept only as a redirect for in-flight bookmarks during dogfooding —
// safe to delete once no inbound links remain.
const FoldersSearch = z.object({
  folderId: z.number().int().optional(),
});

export const Route = createFileRoute("/_app/folders")({
  validateSearch: FoldersSearch,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/notes",
      search: search.folderId !== undefined ? { folder: search.folderId } : {},
    });
  },
});
