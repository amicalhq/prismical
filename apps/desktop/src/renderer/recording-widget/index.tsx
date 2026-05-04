import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { api, trpcClient } from "@/trpc/react";
import { combinedLevel, useMeetingLevel } from "@/hooks/useMeetingLevel";
import type { MeetingWidgetState } from "@/types/meeting-widget";
import { IdlePill } from "./idle-pill";
import { DetectionPill } from "./detection-pill";
import { RecordingPill } from "./recording-pill";
import "@/styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

type DragState = { pointerOffsetY: number };

function RecordingWidgetWindow() {
  const initialStateQuery = api.meetingWidget.getState.useQuery();
  const [liveState, setLiveState] = useState<MeetingWidgetState | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const interactiveRef = useRef(false);

  api.meetingWidget.stateUpdates.useSubscription(undefined, {
    onData: (nextState) => setLiveState(nextState),
  });

  // Real-time mic + system audio amplitude (combined max), used to drive the
  // waveform in the recording pill.
  const meetingLevels = useMeetingLevel();
  const waveformLevel = combinedLevel(meetingLevels);

  const startNoteFromIdleMutation = api.meetingWidget.startNoteFromIdle.useMutation();
  const startNoteFromDetectionMutation =
    api.meetingWidget.startNoteFromDetection.useMutation();
  const dismissDetectionMutation = api.meetingWidget.dismissDetection.useMutation();

  const state = liveState ?? initialStateQuery.data ?? null;
  const widgetVisible = state?.visible ?? false;
  const meetingState = state?.meetingState ?? "idle";
  const meetingDetection = state?.meetingDetection ?? null;
  const currentNoteId = state?.noteId ?? null;

  const isRecording =
    meetingState === "recording" ||
    meetingState === "starting" ||
    meetingState === "stopping" ||
    meetingState === "error";
  const isDetection = !isRecording && meetingDetection !== null;

  const isInteractive = isHovered || dragState !== null;

  const syncInteractive = useCallback((nextInteractive: boolean) => {
    if (interactiveRef.current === nextInteractive) {
      return;
    }
    interactiveRef.current = nextInteractive;
    void window.electronAPI.recordingWidget.setInteractive(nextInteractive);
  }, []);

  useEffect(() => {
    if (!widgetVisible && dragState === null) {
      syncInteractive(false);
    }
  }, [dragState, syncInteractive, widgetVisible]);

  useEffect(() => {
    syncInteractive(isInteractive);
  }, [isInteractive, syncInteractive]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      void window.electronAPI.recordingWidget.dragMove(
        event.screenY,
        dragState.pointerOffsetY,
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      void window.electronAPI.recordingWidget.dragEnd(
        event.screenY,
        dragState.pointerOffsetY,
      );
      setDragState(null);
      setIsHovered(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState]);

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null;
      const nextHovered = !!target?.closest("[data-hit-zone='true']");
      setIsHovered(nextHovered);
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    if (!dragState) {
      setIsHovered(false);
    }
  }, [dragState]);

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragState({ pointerOffsetY: event.clientY });
      setIsHovered(true);
    },
    [],
  );

  const handleStop = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void window.electronAPI.recordingWidget.stopMeeting();
    },
    [],
  );

  const handleOpenNote = useCallback(() => {
    void window.electronAPI.recordingWidget.openNote({
      noteId: currentNoteId,
      openTranscription: isRecording && currentNoteId !== null,
    });
  }, [currentNoteId, isRecording]);

  const handleTakeNotesIdle = useCallback(() => {
    startNoteFromIdleMutation.mutate();
  }, [startNoteFromIdleMutation]);

  const handleTakeNotesDetection = useCallback(() => {
    startNoteFromDetectionMutation.mutate();
  }, [startNoteFromDetectionMutation]);

  const handleDismissDetection = useCallback(() => {
    dismissDetectionMutation.mutate();
  }, [dismissDetectionMutation]);

  const showHandle = isHovered || dragState !== null;

  return (
    <main
      className="h-screen w-screen bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex h-full w-full items-center justify-end pr-1">
        <motion.div
          data-hit-zone="true"
          initial={false}
          animate={
            widgetVisible ? { opacity: 1, x: 0 } : { opacity: 0, x: 24 }
          }
          transition={{ type: "spring", stiffness: 280, damping: 26, mass: 0.7 }}
          className="flex items-center gap-1.5"
        >
          <motion.button
            type="button"
            data-hit-zone="true"
            onPointerDown={handleDragStart}
            initial={false}
            animate={{ opacity: showHandle ? 1 : 0, x: showHandle ? 0 : 6 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="pointer-events-auto flex h-[34px] w-[18px] items-center justify-center rounded-full border border-white/10 bg-[rgba(12,14,18,0.72)] text-white/45 backdrop-blur-md shadow-[0_10px_24px_rgba(3,6,14,0.28)]"
            aria-label="Drag recording widget"
          >
            <div className="grid grid-cols-2 gap-[3px]">
              {Array.from({ length: 6 }).map((_, i) => (
                <span key={i} className="h-[3px] w-[3px] rounded-full bg-current" />
              ))}
            </div>
          </motion.button>

          <AnimatePresence mode="wait" initial={false}>
            {isRecording ? (
              <RecordingPill
                key="recording"
                hovered={isHovered || dragState !== null}
                meetingState={meetingState}
                level={waveformLevel}
                onStop={handleStop}
                onOpenNote={handleOpenNote}
              />
            ) : isDetection && meetingDetection ? (
              <DetectionPill
                key="detection"
                payload={meetingDetection}
                onTakeNotes={handleTakeNotesDetection}
                onDismiss={handleDismissDetection}
                takingNotes={startNoteFromDetectionMutation.isPending}
                dismissing={dismissDetectionMutation.isPending}
              />
            ) : (
              <IdlePill
                key="idle"
                hovered={isHovered || dragState !== null}
                onTakeNotes={handleTakeNotesIdle}
                takingNotes={startNoteFromIdleMutation.isPending}
              />
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </main>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RecordingWidgetWindow />
      </QueryClientProvider>
    </api.Provider>,
  );
}
