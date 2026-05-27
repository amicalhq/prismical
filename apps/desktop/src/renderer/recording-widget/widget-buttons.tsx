import React, { forwardRef } from "react";
import type { ReactNode } from "react";

export interface TakeNotesButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
}

export const TakeNotesButton = forwardRef<
  HTMLButtonElement,
  TakeNotesButtonProps
>(function TakeNotesButton({ loading, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      data-hit-zone="true"
      {...props}
      className={`flex h-8 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.08] pl-1 pr-3 text-[12px] font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-white/25 hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-60 ${props.className ?? ""}`}
    >
      <span
        className="block size-[22px] flex-none rounded-md bg-cover bg-center"
        style={{ backgroundImage: "url('assets/icon.svg')" }}
      />
      <span>Take Notes</span>
    </button>
  );
});

export interface OutlinedIconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

export const OutlinedIconButton = forwardRef<
  HTMLButtonElement,
  OutlinedIconButtonProps
>(function OutlinedIconButton({ children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-hit-zone="true"
      {...props}
      className={`flex size-8 items-center justify-center rounded-full border border-white/20 bg-transparent text-white/70 transition-colors hover:border-white/35 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
});
