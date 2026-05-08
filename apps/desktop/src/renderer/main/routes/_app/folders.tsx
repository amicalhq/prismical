import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AllFoldersPage } from "../../pages/folders/all-folders-page";

const FoldersSearch = z.object({
  folderId: z.number().int().optional(),
});

export const Route = createFileRoute("/_app/folders")({
  validateSearch: FoldersSearch,
  component: AllFoldersPage,
});
