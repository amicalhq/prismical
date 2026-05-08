import { createFileRoute } from "@tanstack/react-router";
import { AllTagsPage } from "../../pages/tags/all-tags-page";

export const Route = createFileRoute("/settings/tags")({
  component: AllTagsPage,
});
