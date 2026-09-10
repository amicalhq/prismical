import * as React from "react";
import { cn } from "../lib/utils";

// ─── TagHash ──────────────────────────────────────────────────────────────────
// Mirrors the desktop `TagHash` — a coloured monospace "#" followed by the tag
// name. Takes raw `color`/`name` so it works for both Tag records and ad-hoc
// rows (e.g. command-palette results).

interface TagHashProps {
  /** `null` for a tag that hasn't resolved yet — the hash falls back to muted. */
  color: string | null;
  name: string;
  /** "xs" for dense rows (the note list's meta line); "sm" everywhere else. */
  size?: "sm" | "xs";
  className?: string;
}

export function TagHash({ color, name, size = "sm", className }: TagHashProps) {
  const text = size === "xs" ? "text-xs" : "text-sm";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "shrink-0 font-mono font-bold leading-none",
          text,
          color === null && "text-muted-foreground",
        )}
        style={{ color: color ?? undefined, width: size === "xs" ? 10 : 14, textAlign: "center" }}
      >
        #
      </span>
      <span className={cn("truncate", text)}>{name}</span>
    </span>
  );
}

// ─── TagBadge ─────────────────────────────────────────────────────────────────
// The badge form of a tag, for everywhere OUTSIDE the sidebar and the dropdown
// lists: note metadata, the /notes filter trigger. Same logic as TagHash — the
// colour identifies via the hash, the name stays in the normal text colour — but
// wrapped in a tinted chip so it reads as a removable object rather than a link.
//
// Deliberately NOT the old outlined-pill-with-a-dot: tinting the border, the dot
// AND the name made a row of tags read louder than the sidebar it mirrors, and a
// note carrying five tags became a row of coloured words.

// `color` is omitted from the button props: it collides with the native HTML
// color attribute, which is a plain string.
interface TagBadgeProps extends Omit<React.ComponentPropsWithoutRef<"button">, "color"> {
  /** `null` for a tag that hasn't resolved yet — falls back to a neutral chip. */
  color: string | null;
  name: string;
  /** Caps the name; the chip itself never grows past its container. */
  nameClassName?: string;
  /**
   * Render a real <button> instead of a <span>. Off by default because the
   * /notes filter trigger draws these INSIDE its own button, and a nested
   * button is invalid HTML.
   */
  interactive?: boolean;
}

export const TagBadge = React.forwardRef<HTMLButtonElement, TagBadgeProps>(function TagBadge(
  { color, name, nameClassName, className, interactive = false, ...rest },
  ref,
) {
  const Root = (interactive ? "button" : "span") as "button";
  return (
    <Root
      ref={interactive ? ref : undefined}
      {...(interactive ? { type: "button" as const } : {})}
      {...rest}
      className={cn(
        "inline-flex h-[22px] min-w-0 max-w-full shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs font-medium",
        color === null ? "bg-muted-foreground/15 text-muted-foreground" : "text-foreground",
        interactive && "transition-[filter] hover:brightness-125",
        className,
      )}
      style={
        color === null
          ? undefined
          : // Tag colours are oklch, so there's no hex alpha to append — color-mix
            // gives the translucent fill the desktop gets from an 8-digit hex.
            { backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }
      }
    >
      <span
        aria-hidden="true"
        className="shrink-0 font-mono font-bold leading-none"
        style={{ color: color ?? undefined }}
      >
        #
      </span>
      <span className={cn("truncate", nameClassName)}>{name}</span>
    </Root>
  );
});
