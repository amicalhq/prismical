import { createFileRoute } from "@tanstack/react-router";
import { SkillEditorPage } from "@/renderer/main/pages/skills/skill-editor-page";

export const Route = createFileRoute("/_app/skills/new")({
  component: () => <SkillEditorPage mode="new" />,
});
