import { IconLock, IconPencil, IconTrash } from "@tabler/icons-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import type { Skill } from "@/db/schema";

interface Props {
  skill: Skill;
  onToggleEnabled: (id: string, next: boolean) => void;
  onDelete: (skill: Skill) => void;
  busy?: boolean;
}

export function SkillRow({ skill, onToggleEnabled, onDelete, busy }: Props) {
  const surfaces = skill.config.surface.join(" · ");
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0">
      <div className="text-lg">✨</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{skill.name}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
            {skill.config.editingOptions}
          </span>
          <span className="text-xs text-muted-foreground">{surfaces}</span>
        </div>
        {skill.description ? (
          <p className="text-sm text-muted-foreground truncate">
            {skill.description}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {skill.system ? (
          <span title="System skill — locked" className="text-muted-foreground">
            <IconLock size={18} />
          </span>
        ) : (
          <Switch
            checked={skill.enabled}
            onCheckedChange={(next) => onToggleEnabled(skill.id, next)}
            disabled={busy}
            aria-label={`Enable ${skill.name}`}
          />
        )}
        {!skill.system ? (
          <>
            <Button variant="ghost" size="icon" asChild>
              <Link to="/skills/$skillId" params={{ skillId: skill.id }}>
                <IconPencil size={18} />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(skill)}
              disabled={busy}
            >
              <IconTrash size={18} />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
