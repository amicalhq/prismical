import { IconSparkles, IconChevronDown, IconDots, IconPlayerStop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { api } from "@/trpc/react";
import { useRunSkill } from "@/renderer/main/hooks/use-run-skill";
import type { ArtifactMode } from "@/db/schema";

const MODE_LABELS: Record<ArtifactMode, string> = {
  "append-section": "Append section",
  "replace-doc": "Replace document",
  "inline-rewrite": "Inline rewrite",
};

interface Props {
  noteId: number;
}

export function SkillSparkleButton({ noteId }: Props) {
  const { data: skills = [] } = api.skills.listForSurface.useQuery({ surface: "dock" });
  // Poll only while a run is suspected in-flight to avoid background spam
  // when the user is idle. Once `data` is null, polling stops; it re-engages
  // automatically when a `run` mutation invalidates this query and the next
  // refetch lands a truthy value.
  const { data: inFlight } = api.skillRuns.getInFlight.useQuery(
    { noteId },
    { refetchInterval: (q) => (q.state.data ? 1000 : false) },
  );
  const utils = api.useUtils();
  const cancel = api.skillRuns.cancel.useMutation({
    onSettled: () => utils.skillRuns.getInFlight.invalidate({ noteId }),
  });
  const { runSkill } = useRunSkill();

  const defaultSkill =
    skills.find((s) => s.config.defaultSkill === true) ?? skills[0];

  if (inFlight) {
    return (
      <Button variant="outline" size="sm" onClick={() => cancel.mutate({ noteId })}>
        <IconPlayerStop size={16} className="mr-1" /> Stop
      </Button>
    );
  }

  if (!defaultSkill) {
    return null; // no dock-surface skill enabled; show nothing
  }

  return (
    <div className="flex items-center">
      <Button
        variant="outline"
        size="sm"
        className="rounded-r-none"
        onClick={() =>
          runSkill({
            noteId,
            skillSlug: defaultSkill.slug,
            skillName: defaultSkill.name,
          })
        }
      >
        <IconSparkles size={16} className="mr-1" />
        {defaultSkill.name}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="rounded-l-none border-l-0 px-1">
            <IconChevronDown size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          {skills.map((s) => (
            <SkillDropdownRow
              key={s.id}
              skill={s}
              onRun={(mode) =>
                runSkill({
                  noteId,
                  skillSlug: s.slug,
                  skillName: s.name,
                  modeOverride: mode,
                })
              }
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface SkillDropdownRowProps {
  skill: { id: string; slug: string; name: string };
  onRun: (mode?: ArtifactMode) => void;
}

function SkillDropdownRow({ skill, onRun }: SkillDropdownRowProps) {
  return (
    <div className="flex items-center">
      <DropdownMenuItem className="flex-1" onClick={() => onRun(undefined)}>
        {skill.name}
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="px-2">
          <IconDots size={14} />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {(Object.keys(MODE_LABELS) as ArtifactMode[]).map((mode) => (
            <DropdownMenuItem key={mode} onClick={() => onRun(mode)}>
              {MODE_LABELS[mode]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </div>
  );
}
