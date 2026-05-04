import { IconNotes } from "@tabler/icons-react";

export type RecordingJumpPillProps = {
  title: string;
  onJump: () => void;
  // i18n is the cluster's responsibility (it has access to useTranslation).
  // Pass a fully-resolved screen-reader label, e.g. "Return to recording: <title>".
  ariaLabel: string;
};

export function RecordingJumpPill({
  title,
  onJump,
  ariaLabel,
}: RecordingJumpPillProps) {
  return (
    <button
      type="button"
      onClick={onJump}
      aria-label={ariaLabel}
      className="
        group flex h-[42px] items-center gap-2 rounded-[28px]
        bg-black/80 dark:bg-black/70 backdrop-blur-md
        ring-[1px] ring-black/60
        shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)]
        pl-3 pr-4
        transition-all duration-200 ease-out
        hover:scale-110 hover:bg-white/5
        cursor-pointer
        select-none
      "
    >
      <IconNotes className="h-[18px] w-[18px] shrink-0 text-white/70 group-hover:text-white" />
      <span className="max-w-[240px] truncate text-sm font-medium text-white/90 group-hover:text-white">
        {title}
      </span>
    </button>
  );
}
