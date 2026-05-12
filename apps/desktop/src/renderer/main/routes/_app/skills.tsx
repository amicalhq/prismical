import { createFileRoute } from "@tanstack/react-router";
import { SkillsListPage } from "@/renderer/main/pages/skills/skills-list-page";

export const Route = createFileRoute("/_app/skills")({
  component: SkillsListPage,
});
