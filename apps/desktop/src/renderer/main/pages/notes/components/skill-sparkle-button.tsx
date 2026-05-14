import {
  IconSparkles,
  IconChevronUp,
  IconDots,
  IconX,
} from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/trpc/react";
import { useRunSkill } from "@/renderer/main/hooks/use-run-skill";
import type { ArtifactMode } from "@/db/schema";

const MODE_LABELS: Record<ArtifactMode, string> = {
  "append-section": "Append section",
  "replace-doc": "Replace document",
  "inline-rewrite": "Inline rewrite",
};

// Visual language matches NoteRecordingDock: 42px-tall dark pill, rounded-28,
// backdrop-blur, ring + soft shadow. The sparkle sits immediately to the right
// of the recording pill — same height, same chrome — so the two read as a
// pair rather than disparate buttons.
const PILL_OUTER =
  "group h-[42px] bg-black/80 dark:bg-black/70 rounded-[28px] backdrop-blur-md " +
  "ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] " +
  "select-none flex items-center transition-all duration-200 ease-out hover:scale-110";

const INNER_BTN =
  "flex h-8 shrink-0 items-center justify-center rounded-full cursor-pointer " +
  "text-white/80 transition-colors hover:bg-white/15 hover:text-white " +
  "active:scale-95 disabled:cursor-not-allowed disabled:opacity-60";

interface Props {
  noteId: number;
}

export function SkillSparkleButton({ noteId }: Props) {
  const { data: skills = [] } = api.skills.listForSurface.useQuery({ surface: "dock" });
  // Poll every second so cross-component consumers (e.g. inline popover when
  // sparkle initiates a run) see the server-side in-flight state without
  // depending on a race-prone pre-mutate invalidate.
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

  // Show the generating state the instant the initiator's mutation is pending
  // — don't wait for the polled query to catch up. `inFlight` still covers
  // cross-component cases (e.g., run initiated from another surface).
  // Visually: sparkle icon + shimmering "Generating" label + a dedicated stop
  // button so the cancel target is separate from the status text.
  if (isPending || inFlight) {
    return (
      <div className={`${PILL_OUTER} pl-3 pr-1 gap-1`}>
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <IconSparkles size={16} className="shrink-0 text-white/80" />
          <span className="shimmer-text-pill">Generating</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Stop skill run"
              className={`${INNER_BTN} w-8 text-white/60`}
              onClick={() => cancel.mutate({ noteId })}
            >
              <IconX size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Stop running skill</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (!defaultSkill) {
    return null; // no dock-surface skill enabled
  }

  return (
    <div className={`${PILL_OUTER} pl-1 pr-1 gap-0.5`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Run ${defaultSkill.name}`}
            className={`${INNER_BTN} gap-1.5 px-3 text-sm font-medium`}
            onClick={() =>
              runSkill({
                noteId,
                skillSlug: defaultSkill.slug,
                skillName: defaultSkill.name,
              })
            }
          >
            <IconSparkles size={18} className="shrink-0" />
            {/* Cap the skill name so a user-named skill like "Convert to
                exec-summary bullets" doesn't blow the pill out across the
                editor — full name still shows in the tooltip below. */}
            <span className="max-w-[140px] truncate">{defaultSkill.name}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Run {defaultSkill.name}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Pick a different skill"
            className={`${INNER_BTN} w-8`}
          >
            <IconChevronUp size={14} />
          </button>
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
      <DropdownMenuItem
        className="min-w-0 flex-1"
        onClick={() => onRun(undefined)}
        title={skill.name}
      >
        <span className="truncate">{skill.name}</span>
      </DropdownMenuItem>
      <DropdownMenuSub>
        {/* Hide the auto-appended ChevronRightIcon (it's the last svg child of
            the trigger) so the dots stand alone — no double "more options"
            iconography per row. */}
        <DropdownMenuSubTrigger className="px-2 [&>svg:last-child]:hidden">
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
