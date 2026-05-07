import { X } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" = resolvedTheme === "light" ? "light" : "dark";
  const styles = tagChipStyles(color, theme);

  const wrapperClass = cn(
    "group/tag inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium",
    className,
  );
  const wrapperStyle = {
    background: styles.background,
    borderColor: styles.border,
    color: styles.foreground,
  };

  // Read-only: plain inline span.
  if (!onClick && !onRemove) {
    return (
      <span className={wrapperClass} style={wrapperStyle}>
        #{name}
      </span>
    );
  }

  // Click-only: a single real button, no nested interactive children.
  if (onClick && !onRemove) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          wrapperClass,
          "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        style={wrapperStyle}
      >
        #{name}
      </button>
    );
  }

  // Click + remove (or remove-only): two sibling buttons in a presentational wrapper.
  return (
    <span className={wrapperClass} style={wrapperStyle}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ color: "inherit", background: "transparent" }}
        >
          #{name}
        </button>
      ) : (
        <span>#{name}</span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={t("settings.notes.note.actions.removeTagNamed", { name })}
          onClick={onRemove}
          className="ml-0.5 hidden h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-black/20 focus-visible:flex group-hover/tag:flex group-focus-within/tag:flex"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
