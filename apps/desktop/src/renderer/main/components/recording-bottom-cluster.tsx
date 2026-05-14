import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";

import { api } from "@/trpc/react";
import { combinedLevel, useMeetingLevel } from "@/hooks/useMeetingLevel";
import { useCurrentNote } from "@/renderer/main/components/current-note-context";
import { useNoteEditor } from "@/renderer/main/components/note-editor-context";
import { useMeetingSnapshot } from "@/renderer/main/components/meeting-snapshot-context";
import { useSkillDiffStore } from "@/renderer/main/components/editor/diff/skill-diff-store";
import { SkillDiffDockBar } from "@/renderer/main/components/editor/diff/skill-diff-dock-bar";
import { NoteAssetsPanel } from "@/renderer/main/pages/notes/components/note-assets-panel";
import { NoteRecordingDock } from "@/renderer/main/pages/notes/components/note-recording-dock";
import { RecordingJumpPill } from "@/renderer/main/components/recording-jump-pill";
import type { MeetingRuntimeState } from "@/types/meeting";

// Spring transition is shared with SkillDiffDockBar so the morph feels like one
// continuous motion across the swap boundary.
const MORPH_TRANSITION = {
  type: "spring" as const,
  stiffness: 320,
  damping: 30,
  mass: 0.7,
};

type DockProps = {
  noteId?: number;
  isTranscriptionOpen?: boolean;
  onToggleTranscription?: () => void;
  meetingState: MeetingRuntimeState;
  level: number;
  onStartMeeting: () => void;
  onStopMeeting: () => void;
};

// DockArea owns the swap between the recording dock (idle/recording state)
// and the skill-diff accept bar (when a candidate is staged for the current
// note). Both surfaces share the same horizontal slot, and AnimatePresence
// cross-fades them so the morph reads as one continuous surface.
function DockArea({
  currentNoteId,
  dockProps,
  jumpPill,
}: {
  currentNoteId: number | undefined;
  dockProps: DockProps;
  jumpPill: React.ReactNode;
}) {
  const noteEditor = useNoteEditor();
  const candidate = useSkillDiffStore((s) =>
    currentNoteId !== undefined
      ? s.candidatesByNote.get(currentNoteId)
      : undefined,
  );
  // Only show the accept bar when we have both a candidate AND the matching
  // editor — otherwise the bar would render without an editor to drive accept
  // / decoration commands.
  const showDiffBar =
    candidate !== undefined &&
    noteEditor !== null &&
    currentNoteId !== undefined &&
    noteEditor.noteId === currentNoteId;

  return (
    <div className="pointer-events-auto flex items-center gap-2">
      <AnimatePresence mode="wait" initial={false}>
        {showDiffBar ? (
          <motion.div
            key="diff-bar"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={MORPH_TRANSITION}
            className="flex items-center"
          >
            <SkillDiffDockBar
              editor={noteEditor!.editor}
              noteId={currentNoteId!}
            />
          </motion.div>
        ) : (
          <motion.div
            key="dock"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={MORPH_TRANSITION}
            className="flex items-center gap-2"
          >
            <NoteRecordingDock {...dockProps} />
            {jumpPill}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function isActiveState(state: MeetingRuntimeState): boolean {
  return (
    state === "starting" ||
    state === "recording" ||
    state === "stopping" ||
    state === "error"
  );
}

export function RecordingBottomCluster() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const currentNote = useCurrentNote();
  const snapshot = useMeetingSnapshot();
  const meetingLevels = useMeetingLevel();
  const dockLevel = combinedLevel(meetingLevels);
  const stopMeetingMutation = api.meetings.stopMeeting.useMutation();

  const recordingActive = isActiveState(snapshot.state);
  const recordingNoteId = snapshot.noteId;

  const onCurrentNote =
    currentNote !== null &&
    recordingNoteId !== null &&
    currentNote.noteId === recordingNoteId;

  // Title fetch — only when we'll actually render the jump pill.
  const needsJumpPill =
    recordingActive && !onCurrentNote && recordingNoteId !== null;

  const recordingNoteQuery = api.notes.getNoteById.useQuery(
    { id: recordingNoteId ?? 0 },
    // `enabled: needsJumpPill` already implies recordingNoteId !== null
    { enabled: needsJumpPill },
  );

  const recordingNoteTitle = needsJumpPill
    ? recordingNoteQuery.data?.title?.trim() ||
      t("settings.notes.untitledTitle")
    : "";

  const handleJump = useCallback(() => {
    if (recordingNoteId === null) return;
    navigate({
      to: "/notes/$noteId",
      params: { noteId: String(recordingNoteId) },
    });
  }, [navigate, recordingNoteId]);

  // Stop dispatch: prefer the wrapper's handler when on the recording note (so
  // wrapper-level cleanup — including transcript refresh — runs). When stopping
  // from another page, the wrapper isn't mounted; we call the mutation directly
  // and invalidate the recording note's transcript query so the next mount
  // re-fetches instead of serving the cached pre-stop transcript.
  const handleStop = useCallback(() => {
    if (onCurrentNote && currentNote) {
      currentNote.onStopMeeting();
      return;
    }
    const stoppedNoteId = recordingNoteId;
    stopMeetingMutation
      .mutateAsync()
      .then(() => {
        if (stoppedNoteId !== null) {
          void utils.meetings.getNoteTranscript.invalidate({
            noteId: stoppedNoteId,
          });
        }
      })
      .catch((error) => {
        toast.error(`Failed to stop recording: ${error.message}`);
      });
  }, [
    onCurrentNote,
    currentNote,
    recordingNoteId,
    stopMeetingMutation,
    utils.meetings.getNoteTranscript,
  ]);

  const handleStart = useCallback(() => {
    if (currentNote) {
      currentNote.onStartMeeting();
    }
  }, [currentNote]);

  // Render-gate: nothing to show if no note in scope AND no active recording.
  if (!currentNote && !recordingActive) {
    return null;
  }

  // Dock state: when recording is active globally, show recording state
  // regardless of which note the user is viewing. Otherwise, show idle.
  const dockMeetingState: MeetingRuntimeState = recordingActive
    ? snapshot.state
    : "idle";

  // Positioning: the cluster mounts inside <SidebarInset> (which is
  // `position: relative`), so `absolute inset-x-0 bottom-4` centres over the
  // content area, not the viewport. Viewport-fixed positioning would ignore
  // the sidebar's width and miscentre the cluster.
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-2 px-6">
        {/*
          Transcription panel: mounted whenever a current note is in scope, so
          open/close transitions animate via class changes (mirrors note.tsx's
          original behaviour). When no current note, the panel is unmounted
          because the underlying transcript data isn't available anyway.
        */}
        {currentNote && (
          <div
            // Force a clean remount when the note in scope changes so the
            // panel doesn't bleed internal state across notes.
            key={currentNote.noteId}
            className={`w-full transition-all duration-200 ease-out ${
              currentNote.isTranscriptionExpanded ? "max-w-4xl" : "max-w-xl"
            } ${
              currentNote.isTranscriptionOpen
                ? `pointer-events-auto opacity-100 ${
                    currentNote.isTranscriptionExpanded
                      ? "h-[75vh]"
                      : "h-[50vh]"
                  }`
                : "pointer-events-none h-0 opacity-0"
            }`}
          >
            <NoteAssetsPanel
              activeAsset="transcription"
              isOpen={currentNote.isTranscriptionOpen}
              onClose={currentNote.onToggleTranscription}
              isExpanded={currentNote.isTranscriptionExpanded}
              onToggleExpanded={() =>
                currentNote.onSetTranscriptionExpanded(
                  !currentNote.isTranscriptionExpanded,
                )
              }
              transcript={currentNote.transcript}
              meetingState={currentNote.meetingState}
            />
          </div>
        )}

        <DockArea
          currentNoteId={currentNote?.noteId}
          dockProps={{
            noteId: currentNote?.noteId,
            isTranscriptionOpen: currentNote
              ? currentNote.isTranscriptionOpen
              : false,
            onToggleTranscription: currentNote
              ? currentNote.onToggleTranscription
              : undefined,
            meetingState: dockMeetingState,
            level: dockLevel,
            onStartMeeting: handleStart,
            onStopMeeting: handleStop,
          }}
          jumpPill={
            needsJumpPill ? (
              <RecordingJumpPill
                title={recordingNoteTitle}
                onJump={handleJump}
                ariaLabel={t("settings.notes.jumpPill.ariaLabel", {
                  title: recordingNoteTitle,
                })}
              />
            ) : null
          }
        />
      </div>
    </div>
  );
}
