import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { api } from "@/trpc/react";
import { combinedLevel, useMeetingLevel } from "@/hooks/useMeetingLevel";
import { useCurrentNote } from "@/renderer/main/components/current-note-context";
import { useMeetingSnapshot } from "@/renderer/main/components/meeting-snapshot-context";
import { NoteAssetsPanel } from "@/renderer/main/pages/notes/components/note-assets-panel";
import { NoteRecordingDock } from "@/renderer/main/pages/notes/components/note-recording-dock";
import { RecordingJumpPill } from "@/renderer/main/components/recording-jump-pill";
import type { MeetingRuntimeState } from "@/types/meeting";

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

        <div className="pointer-events-auto flex items-center gap-2">
          <NoteRecordingDock
            noteId={currentNote?.noteId}
            isTranscriptionOpen={
              currentNote ? currentNote.isTranscriptionOpen : false
            }
            onToggleTranscription={
              currentNote ? currentNote.onToggleTranscription : undefined
            }
            meetingState={dockMeetingState}
            level={dockLevel}
            onStartMeeting={handleStart}
            onStopMeeting={handleStop}
          />

          {needsJumpPill && (
            <RecordingJumpPill
              title={recordingNoteTitle}
              onJump={handleJump}
              ariaLabel={t("settings.notes.jumpPill.ariaLabel", {
                title: recordingNoteTitle,
              })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
