import { Link } from "@tanstack/react-router";
import type { Skill } from "@/db/schema";

interface Props {
  skill: Skill;
}

export function SkillCard({ skill }: Props) {
  return (
    <Link
      to="/settings/skills/$skillId"
      params={{ skillId: skill.id }}
      // h-full + flex-col so the grid's auto-rows-fr keeps every card at the
      // same height; the description's two-line clamp prevents reflow.
      className="group flex h-full flex-col rounded-xl border bg-card p-4 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-3 text-2xl leading-none">✨</div>
      <h3 className="truncate font-medium">{skill.name}</h3>
      <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
        {skill.description ?? (
          <span className="italic opacity-60">No description</span>
        )}
      </p>
    </Link>
  );
}
