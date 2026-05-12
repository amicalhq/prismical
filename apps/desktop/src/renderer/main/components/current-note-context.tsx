import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { MeetingRuntimeState, TranscriptEvent } from "@/types/meeting";

export type CurrentNoteContextValue = {
  noteId: number;
  title: string;

  transcript: TranscriptEvent[];
  isTranscriptionOpen: boolean;
  isTranscriptionExpanded: boolean;
  onToggleTranscription: () => void;
  onSetTranscriptionExpanded: (expanded: boolean) => void;

  // Per-note coerced state (the wrapper sets this to "idle" when the active
  // session belongs to a different note). Used by the transcription panel for
  // its generate-notes gating; NOT used to decide dock idle vs. recording —
  // the cluster makes that decision from the global meeting snapshot.
  meetingState: MeetingRuntimeState;

  onStartMeeting: () => void;
  onStopMeeting: () => void;
};

type Setter = (noteId: number, value: CurrentNoteContextValue | null) => void;

// Two contexts to break a render loop: subscribers of the value (the cluster)
// re-render on every change, but subscribers of the setter (the wrapper)
// must NOT re-render when the value changes — otherwise pushing a new value
// would re-render the pusher and could re-fire its registration effect,
// looping indefinitely.
const CurrentNoteValueContext = createContext<CurrentNoteContextValue | null>(
  null,
);
const CurrentNoteSetContext = createContext<Setter | null>(null);

// Provider mounted at the layout level. Note pages register their current
// state via `useRegisterCurrentNote()` on mount and clear it on unmount, so
// the layout-level cluster (rendered as a sibling of the route Outlet) can
// read the active per-note state through `useCurrentNote()`.
//
// Registrations are keyed by noteId so that when navigating A → B (React
// mounts B before unmounting A), A's cleanup `set(A, null)` is ignored
// because the current owner is already B.
export function CurrentNoteProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<CurrentNoteContextValue | null>(null);

  const set = useCallback<Setter>((noteId, value) => {
    setCurrent((prev) => {
      if (value === null) {
        // Clear request — only honour it if we still own the slot.
        return prev && prev.noteId === noteId ? null : prev;
      }
      return value;
    });
  }, []);

  return (
    <CurrentNoteSetContext.Provider value={set}>
      <CurrentNoteValueContext.Provider value={current}>
        {children}
      </CurrentNoteValueContext.Provider>
    </CurrentNoteSetContext.Provider>
  );
}

export function useCurrentNote(): CurrentNoteContextValue | null {
  return useContext(CurrentNoteValueContext);
}

// Used by note-wrapper to push its per-note value into the layout context.
// Returns a stable setter from a context that never changes — so callers do
// not re-render when the registered value changes.
export function useRegisterCurrentNote(): Setter {
  const set = useContext(CurrentNoteSetContext);
  if (!set) {
    throw new Error(
      "useRegisterCurrentNote must be used within CurrentNoteProvider",
    );
  }
  return set;
}
