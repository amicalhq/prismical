import { createFileRoute } from "@tanstack/react-router";
import { SkillsListPage } from "@/renderer/main/pages/skills/skills-list-page";

export const Route = createFileRoute("/_app/settings/skills/")({
  component: SkillsListPage,
});
