import { cn } from "../lib/utils";
import type { Tag } from "@prismical/app-contracts";

// ─── TagChip ──────────────────────────────────────────────────────────────────

interface TagChipProps {
  tag: Tag;
  count?: number;
  className?: string;
}

export function TagChip({ tag, count, className }: TagChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 text-2xs font-medium",
        className,
      )}
      style={{
        borderColor: tag.color,
        color: tag.color,
        background: "transparent",
      }}
    >
      {/* color dot */}
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: tag.color }}
      />
      <span className="truncate">{tag.name}</span>
      {count !== undefined && (
        <span className="shrink-0 opacity-60">{count}</span>
      )}
    </span>
  );
}

// ─── TagHash ──────────────────────────────────────────────────────────────────
// Mirrors the desktop `TagHash` — a coloured monospace "#" followed by the tag
// name. Takes raw `color`/`name` so it works for both Tag records and ad-hoc
// rows (e.g. command-palette results).

interface TagHashProps {
  color: string;
  name: string;
  className?: string;
}

export function TagHash({ color, name, className }: TagHashProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className="shrink-0 font-mono text-sm font-bold leading-none"
        style={{ color, width: 14, textAlign: "center" }}
      >
        #
      </span>
      <span className="truncate text-sm">{name}</span>
    </span>
  );
}
