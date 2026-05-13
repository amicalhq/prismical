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
  // Poll every second so cross-component consumers (e.g. inline popover when
  // sparkle initiates a run) see the server-side in-flight state without
  // depending on a race-prone pre-mutate invalidate. The 1s cadence is cheap
  // (one request per active note view) and gives the Stop button a reliable
  // cross-component signal.
  const { data: inFlight } = api.skillRuns.getInFlight.useQuery(
    { noteId },
    { refetchInterval: 1000 },
  );
  const utils = api.useUtils();
  const cancel = api.skillRuns.cancel.useMutation({
    onSettled: () => utils.skillRuns.getInFlight.invalidate({ noteId }),
  });
  const { runSkill, isPending } = useRunSkill();

  const defaultSkill =
    skills.find((s) => s.config.defaultSkill === true) ?? skills[0];

  // Show Stop the instant the initiator's mutation is pending — don't wait
  // for the polled query to catch up. `inFlight` still covers cross-component
  // cases (e.g., run initiated from another surface).
  if (isPending || inFlight) {
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
