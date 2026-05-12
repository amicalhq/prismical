import { createFileRoute } from "@tanstack/react-router";
import { SkillEditorPage } from "@/renderer/main/pages/skills/skill-editor-page";

export const Route = createFileRoute("/_app/skills/$skillId")({
  component: () => {
    const { skillId } = Route.useParams();
    return <SkillEditorPage mode="edit" skillId={skillId} />;
  },
});
