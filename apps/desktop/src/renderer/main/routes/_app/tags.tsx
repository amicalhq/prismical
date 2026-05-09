import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

// Legacy /tags route. Replaced by the unified /notes browser in PRSM-30.
// Kept only as a redirect for in-flight bookmarks during dogfooding —
// safe to delete once no inbound links remain.
const TagsSearch = z.object({
  tag: z.number().int().positive().optional(),
});

export const Route = createFileRoute("/_app/tags")({
  validateSearch: TagsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/notes",
      search: search.tag !== undefined ? { tags: [search.tag] } : {},
    });
  },
});
