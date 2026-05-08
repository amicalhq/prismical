import { cn } from "@/lib/utils";

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
        className="shrink-0 font-mono text-[14px] font-bold leading-none"
        style={{ color, width: 14, textAlign: "center" }}
      >
        #
      </span>
      <span className="truncate text-sm">{name}</span>
    </span>
  );
}
