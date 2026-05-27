import React, { forwardRef } from "react";
import type { ReactNode } from "react";

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible tooltip text. Shown via native title attribute. */
  tooltip: string;
  /** Lucide / Tabler icon node, 16-18px. */
  icon: ReactNode;
  /** When true, the button uses the destructive (red) accent. */
  destructive?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { tooltip, icon, destructive, disabled, className, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        data-hit-zone="true"
        title={tooltip}
        aria-label={tooltip}
        disabled={disabled}
        className={[
          "pointer-events-auto flex size-9 items-center justify-center rounded-full",
          "border border-white/15 bg-black/80 backdrop-blur-md",
          "shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
          "transition-colors",
          destructive
            ? "text-red-400 hover:border-white/35 hover:bg-white/10"
            : "text-white/85 hover:border-white/35 hover:bg-white/10 hover:text-white",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className ?? "",
        ].join(" ")}
        {...rest}
      >
        {icon}
      </button>
    );
  },
);
