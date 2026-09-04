import { create } from "zustand";

// Tracks which notes currently have a skill run in flight, across ALL useRunSkill instances (dock
// sparkle, dock refine, inline popover requests routed through the dock). The inline popover needs
// this to hide while any run is pending — its own instance-local `running` can't see runs started
// elsewhere. Counted (not boolean) so overlapping runs — e.g. a refine racing an
// abort — can't flip the flag off early.
interface SkillRunActivityState {
  runningByNote: Map<string, number>;
  start: (noteId: string) => void;
  stop: (noteId: string) => void;
}

export const useSkillRunActivityStore = create<SkillRunActivityState>((set) => ({
  runningByNote: new Map(),

  start: (noteId) =>
    set((s) => {
      const next = new Map(s.runningByNote);
      next.set(noteId, (next.get(noteId) ?? 0) + 1);
      return { runningByNote: next };
    }),

  stop: (noteId) =>
    set((s) => {
      const next = new Map(s.runningByNote);
      const count = (next.get(noteId) ?? 1) - 1;
      if (count <= 0) next.delete(noteId);
      else next.set(noteId, count);
      return { runningByNote: next };
    }),
}));

/** True while any skill run is in flight for `noteId`. */
export function useSkillRunActive(noteId: string): boolean {
  return useSkillRunActivityStore((s) => (s.runningByNote.get(noteId) ?? 0) > 0);
}
