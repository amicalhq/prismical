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
import type {
  MeetingWidgetEdge,
  MeetingWidgetState,
} from "@/types/meeting-widget";
import { IdlePill } from "./idle-pill";
import { DetectionPill } from "./detection-pill";
import { RecordingPill } from "./recording-pill";
import "@/styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

type DragState = { pointerOffsetX: number; pointerOffsetY: number };

interface DragHandleProps {
  edge: MeetingWidgetEdge;
  visible: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
}

function DragHandle({ edge, visible, onPointerDown }: DragHandleProps) {
  const isVertical = edge === "right";
  return (
    <motion.button
      type="button"
      data-hit-zone={visible ? "true" : undefined}
      onPointerDown={onPointerDown}
      initial={false}
      animate={{ opacity: visible ? 1 : 0, scale: visible ? 1 : 0.85 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
      className={`pointer-events-auto flex ${
        isVertical ? "h-[18px] w-[28px]" : "h-[28px] w-[18px]"
      } items-center justify-center rounded-full border border-white/10 bg-[rgba(12,14,18,0.72)] text-white/45 backdrop-blur-md shadow-[0_8px_20px_rgba(3,6,14,0.28)]`}
      aria-label="Drag recording widget"
    >
      <div
        className={`grid ${
          isVertical ? "grid-cols-3 grid-rows-2" : "grid-cols-2 grid-rows-3"
        } gap-[2.5px]`}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="h-[2.5px] w-[2.5px] rounded-full bg-current" />
        ))}
      </div>
    </motion.button>
  );
}

function RecordingWidgetWindow() {
  const initialStateQuery = api.meetingWidget.getState.useQuery();
  const [liveState, setLiveState] = useState<MeetingWidgetState | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const interactiveRef = useRef(false);

  api.meetingWidget.stateUpdates.useSubscription(undefined, {
    onData: (nextState) => setLiveState(nextState),
  });

  const meetingLevels = useMeetingLevel();
  const waveformLevel = combinedLevel(meetingLevels);

  const startNoteFromIdleMutation = api.meetingWidget.startNoteFromIdle.useMutation();
  const startNoteFromDetectionMutation =
    api.meetingWidget.startNoteFromDetection.useMutation();
  const dismissDetectionMutation = api.meetingWidget.dismissDetection.useMutation();
  const createBlankNoteMutation = api.meetingWidget.createBlankNote.useMutation();

  const state = liveState ?? initialStateQuery.data ?? null;
  const widgetVisible = state?.visible ?? false;
  const meetingState = state?.meetingState ?? "idle";
  const meetingDetection = state?.meetingDetection ?? null;
  const currentNoteId = state?.noteId ?? null;
  const edge: MeetingWidgetEdge = state?.edge ?? "right";

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
        event.screenX,
        event.screenY,
        dragState.pointerOffsetX,
        dragState.pointerOffsetY,
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      void window.electronAPI.recordingWidget.dragEnd(
        event.screenX,
        event.screenY,
        dragState.pointerOffsetX,
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
      setDragState({
        pointerOffsetX: event.clientX,
        pointerOffsetY: event.clientY,
      });
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

  const handleStartRecording = useCallback(() => {
    startNoteFromIdleMutation.mutate();
  }, [startNoteFromIdleMutation]);

  const handleTakeNotes = useCallback(() => {
    createBlankNoteMutation.mutate();
  }, [createBlankNoteMutation]);

  const handleTakeNotesDetection = useCallback(() => {
    startNoteFromDetectionMutation.mutate();
  }, [startNoteFromDetectionMutation]);

  const handleDismissDetection = useCallback(() => {
    dismissDetectionMutation.mutate();
  }, [dismissDetectionMutation]);

  const showHandle = isHovered || dragState !== null;

  // Outer container anchors the visible content to the active edge.
  const outerJustify =
    edge === "right"
      ? "items-center justify-end pr-1"
      : "items-end justify-center pb-1";
  const innerLayout =
    edge === "right"
      ? "flex flex-col items-center gap-1.5"
      : "flex flex-row items-center gap-1.5";

  const dragHandleEl = (
    <DragHandle
      edge={edge}
      visible={showHandle}
      onPointerDown={handleDragStart}
    />
  );

  return (
    <main
      className="h-screen w-screen bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`flex h-full w-full ${outerJustify}`}>
        <motion.div
          initial={false}
          animate={widgetVisible ? { opacity: 1 } : { opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 26, mass: 0.7 }}
        >
          <div className={innerLayout}>
            {edge === "bottom" ? dragHandleEl : null}
            <AnimatePresence mode="wait" initial={false}>
              {isRecording ? (
                <RecordingPill
                  key="recording"
                  edge={edge}
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
                  edge={edge}
                  hovered={isHovered || dragState !== null}
                  onTakeNotes={handleTakeNotes}
                  takingNotes={createBlankNoteMutation.isPending}
                  onStartRecording={handleStartRecording}
                  startingRecording={startNoteFromIdleMutation.isPending}
                />
              )}
            </AnimatePresence>
            {edge === "right" ? dragHandleEl : null}
          </div>
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
