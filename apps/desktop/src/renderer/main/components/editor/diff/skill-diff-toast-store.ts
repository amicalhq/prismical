import { create } from "zustand";

// A tiny transient-message slot used by the skill-diff accept flow. The
// cluster reads `message` and renders a small dock-styled pill above the
// dock; the accept handler calls `show()` after `editor.commands.*` so the
// user sees confirmation even when the inserted content lands off-screen.
//
// Implemented as a single-slot store on purpose: only one accept happens at
// a time, and stacking multiple transient banners above the dock would
// crowd the editor.
interface State {
  message: string | null;
  show: (message: string) => void;
  dismiss: () => void;
}

const DISPLAY_MS = 2500;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export const useSkillDiffToastStore = create<State>((set) => ({
  message: null,
  show: (message) => {
    if (dismissTimer) clearTimeout(dismissTimer);
    set({ message });
    dismissTimer = setTimeout(() => {
      set({ message: null });
      dismissTimer = null;
    }, DISPLAY_MS);
  },
  dismiss: () => {
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = null;
    set({ message: null });
  },
}));
