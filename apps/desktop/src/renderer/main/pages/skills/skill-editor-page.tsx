interface Props { mode: "new" | "edit"; skillId?: string }
export function SkillEditorPage({ mode, skillId }: Props) {
  return <div className="p-8">Skill editor ({mode}{skillId ? `: ${skillId}` : ""}) (coming soon)</div>;
}
