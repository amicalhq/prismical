import { IconDotsVertical, IconLock, IconPencil, IconTrash } from "@tabler/icons-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@tanstack/react-router";
import { api } from "@/trpc/react";
import type { Skill } from "@/db/schema";

interface Props {
  skill: Skill;
  onToggleEnabled: (id: string, next: boolean) => void;
  onDelete: (skill: Skill) => void;
  busy?: boolean;
}

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SkillRow({ skill, onToggleEnabled, onDelete, busy }: Props) {
  const surfaces = skill.config.surface.join(" · ");
  const utils = api.useUtils();

  const handleExportJson = async () => {
    const result = await utils.skills.exportAsJson.fetch({ id: skill.id });
    triggerDownload(
      JSON.stringify(result.json, null, 2),
      `${skill.slug}.json`,
      "application/json",
    );
  };

  const handleExportMarkdown = async () => {
    const result = await utils.skills.exportAsMarkdown.fetch({ id: skill.id });
    triggerDownload(result.markdown, `${skill.slug}.md`, "text/markdown");
  };

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
        {/* Export menu — available for all skills (system and user) */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More options">
              <IconDotsVertical size={18} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={handleExportJson}>
              Export as JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleExportMarkdown}>
              Export as Markdown
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
