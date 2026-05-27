import React, { forwardRef } from "react";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Tooltip text. Rendered via radix tooltip; falsy = no tooltip wrapper. */
  tooltip: string;
  /** Lucide / Tabler icon node, 16-18px. */
  icon: ReactNode;
  /** When true, the button uses the destructive (red) accent. */
  destructive?: boolean;
  /** Side the tooltip floats on. Defaults to "left" so it doesn't get clipped
   *  by the right edge of the screen for right-anchored widgets. */
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      tooltip,
      icon,
      destructive,
      disabled,
      className,
      tooltipSide = "left",
      ...rest
    },
    ref,
  ) {
    const button = (
      <button
        ref={ref}
        type="button"
        data-hit-zone="true"
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

    if (!tooltip) {
      return button;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltipSide} sideOffset={6}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    );
  },
);
