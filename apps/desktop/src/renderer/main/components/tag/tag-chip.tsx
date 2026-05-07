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

  return (
    <span
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "group/tag inline-flex h-[22px] items-center gap-1 rounded-full border px-2 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
          aria-label={t("settings.notes.note.actions.removeTagNamed", { name })}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 hidden h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-black/20 focus-visible:flex group-hover/tag:flex group-focus-within/tag:flex"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
