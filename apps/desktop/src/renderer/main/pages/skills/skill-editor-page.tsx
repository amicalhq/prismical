import { api } from "@/trpc/react";
import { Navigate } from "@tanstack/react-router";
import { SkillForm } from "./components/skill-form";

interface Props {
  mode: "new" | "edit";
  skillId?: string;
}

export function SkillEditorPage({ mode, skillId }: Props) {
  if (mode === "new") return <SkillForm mode="new" />;

  if (!skillId) return <Navigate to="/settings/skills" />;

  const { data: existing, isLoading, error } = api.skills.getById.useQuery(
    { id: skillId },
  );

  if (isLoading) return <div className="p-8">Loading…</div>;
  if (error || !existing) return <Navigate to="/settings/skills" />;

  return <SkillForm mode="edit" existing={existing} />;
}
