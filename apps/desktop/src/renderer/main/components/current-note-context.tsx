import { createContext, useContext, type ReactNode } from "react";
import type { MeetingRuntimeState, TranscriptEvent } from "@/types/meeting";
import type { NoteTab } from "@/renderer/main/pages/notes/components/note";

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

  hasArtifact: boolean;
  activeTab: NoteTab;
  onActiveTabChange: (tab: NoteTab) => void;

  onGenerateNotes: () => void;
  isGeneratingNotes: boolean;
};

const CurrentNoteContext = createContext<CurrentNoteContextValue | null>(null);

export function CurrentNoteProvider({
  value,
  children,
}: {
  value: CurrentNoteContextValue;
  children: ReactNode;
}) {
  return (
    <CurrentNoteContext.Provider value={value}>
      {children}
    </CurrentNoteContext.Provider>
  );
}

// Returns null when called outside a provider — the global recording cluster
// uses null to mean "no current note in scope" (e.g., on /settings/home).
export function useCurrentNote(): CurrentNoteContextValue | null {
  return useContext(CurrentNoteContext);
}
