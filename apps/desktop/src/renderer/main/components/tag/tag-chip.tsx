import * as React from "react";
import { X } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { tagChipStyles } from "@/renderer/main/lib/tag-colors";

interface TagChipProps {
  name: string;
  color: string;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
}

export function TagChip({
  name,
  color,
  onClick,
  onRemove,
  className,
}: TagChipProps) {
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark";
  const styles = tagChipStyles(color, theme);

  return (
    <span
      role={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "group/tag inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium",
        onClick && "cursor-pointer",
        className,
      )}
      style={{
        background: styles.background,
        borderColor: styles.border,
        color: styles.foreground,
      }}
    >
      <span>#{name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 hidden h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-black/20 group-hover/tag:flex"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
