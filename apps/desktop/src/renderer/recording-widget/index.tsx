import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeftToLine,
  Loader2,
  Square,
} from "lucide-react";
import { Waveform } from "@/components/Waveform";
import { api, trpcClient } from "@/trpc/react";
import type { MeetingWidgetState } from "@/types/meeting-widget";
import "@/styles/globals.css";

const NUM_WAVEFORM_BARS = 6;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

type DragState = {
  pointerOffsetY: number;
};

const PILL_SHELL_CLASS =
  "relative pointer-events-auto bg-black/80 dark:bg-black/70 backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] before:content-[''] before:absolute before:inset-[1px] before:outline before:outline-white/15 before:pointer-events-none";

function RecordingWidgetWindow() {
  const initialStateQuery = api.meetingWidget.getState.useQuery();
  const [liveState, setLiveState] = useState<MeetingWidgetState | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [voiceDetected, setVoiceDetected] = useState(false);
  const interactiveRef = useRef(false);
  const voiceIntervalRef = useRef<NodeJS.Timeout | null>(null);

  api.meetingWidget.stateUpdates.useSubscription(undefined, {
    onData: (nextState) => setLiveState(nextState),
  });

  const state = liveState ?? initialStateQuery.data ?? null;
  const widgetVisible = state?.visible ?? false;
  const meetingState = state?.meetingState ?? "idle";

  const isError = meetingState === "error";
  const isRecording =
    meetingState === "recording" ||
    meetingState === "starting" ||
    meetingState === "stopping";
  const isStarting = meetingState === "starting";
  const isStopping = meetingState === "stopping";
  const isBusy = isStarting || isStopping;
  const isActive = isRecording || isError;

  // Demo voice-detected toggle so the waveform looks alive — same trick the
  // in-app dock uses until we wire real RMS data through.
  useEffect(() => {
    if (meetingState === "recording") {
      voiceIntervalRef.current = setInterval(() => {
        setVoiceDetected((prev) => !prev);
      }, 1200);
    } else {
      setVoiceDetected(false);
      if (voiceIntervalRef.current) {
        clearInterval(voiceIntervalRef.current);
        voiceIntervalRef.current = null;
      }
    }
    return () => {
      if (voiceIntervalRef.current) {
        clearInterval(voiceIntervalRef.current);
        voiceIntervalRef.current = null;
      }
    };
  }, [meetingState]);

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

  const currentNoteId = state?.noteId ?? null;

  const handleOpenApp = useCallback(() => {
    // Snapshot `noteId` here rather than letting the main process re-read it,
    // because the manager may transition `noteId` to null during `stopping`
    // → `idle` between this click and the IPC handler firing.
    void window.electronAPI.recordingWidget.openNote({
      noteId: currentNoteId,
      openTranscription: isActive && currentNoteId !== null,
    });
  }, [currentNoteId, isActive]);

  const handleStop = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void window.electronAPI.recordingWidget.stopMeeting();
  }, []);

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragState({ pointerOffsetY: event.clientY });
      setIsHovered(true);
    },
    [],
  );

  const showHandle = isHovered || dragState !== null;

  return (
    <main
      className="h-screen w-screen bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex h-full w-full items-center justify-end pr-1">
        <motion.div
          initial={false}
          animate={
            widgetVisible
              ? { opacity: 1, x: 0 }
              : { opacity: 0, x: 24 }
          }
          transition={{
            type: "spring",
            stiffness: 280,
            damping: 26,
            mass: 0.7,
          }}
          className="flex items-center gap-1.5"
        >
          {/* Drag handle (left of pill) — visible on hover */}
          <motion.button
            type="button"
            data-hit-zone="true"
            onPointerDown={handleDragStart}
            initial={false}
            animate={{
              opacity: showHandle ? 1 : 0,
              x: showHandle ? 0 : 6,
            }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="pointer-events-auto flex h-[34px] w-[18px] items-center justify-center rounded-full border border-white/10 bg-[rgba(12,14,18,0.72)] text-white/45 backdrop-blur-md shadow-[0_10px_24px_rgba(3,6,14,0.28)]"
            aria-label="Drag recording widget"
          >
            <div className="grid grid-cols-2 gap-[3px]">
              {Array.from({ length: 6 }).map((_, i) => (
                <span
                  key={i}
                  className="h-[3px] w-[3px] rounded-full bg-current"
                />
              ))}
            </div>
          </motion.button>

          <AnimatePresence mode="wait" initial={false}>
            {isActive ? (
              <motion.div
                key="recording"
                data-hit-zone="true"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className={`${PILL_SHELL_CLASS} flex w-[44px] flex-col items-center justify-between rounded-[24px] before:rounded-[23px] py-2 gap-1.5`}
                style={{ minHeight: 140 }}
              >
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={isBusy}
                  className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/15 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label={isError ? "Recording error" : "Stop recording"}
                >
                  {isBusy ? (
                    <Loader2 className="h-5 w-5 animate-spin text-white/80" />
                  ) : isError ? (
                    <AlertTriangle className="h-[18px] w-[18px] text-red-400" />
                  ) : (
                    <Square className="h-[18px] w-[18px] fill-red-500 text-red-500" />
                  )}
                </button>

                <div className="flex h-7 w-full items-end justify-center gap-[3px] px-2">
                  {Array.from({ length: NUM_WAVEFORM_BARS }).map((_, index) => (
                    <Waveform
                      key={index}
                      index={index}
                      isRecording={meetingState === "recording"}
                      voiceDetected={voiceDetected}
                      baseHeight={90}
                      silentHeight={30}
                    />
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleOpenApp}
                  className="flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/15 hover:text-white cursor-pointer"
                  aria-label="Open meeting note with transcription"
                >
                  <ArrowLeftToLine className="h-[18px] w-[18px]" />
                </button>
              </motion.div>
            ) : (
              <motion.button
                key="idle"
                type="button"
                data-hit-zone="true"
                onClick={handleOpenApp}
                initial={false}
                animate={
                  isHovered
                    ? { width: 36, height: 110 }
                    : { width: 8, height: 56 }
                }
                transition={{ duration: 0.18, ease: "easeOut" }}
                className={`${PILL_SHELL_CLASS} flex items-center justify-center rounded-full before:rounded-full text-white/70 hover:text-white overflow-hidden`}
                aria-label="Open Prismical"
              >
                <AnimatePresence>
                  {isHovered && (
                    <motion.span
                      key="idle-icon"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12, delay: 0.08 }}
                      className="flex items-center justify-center"
                    >
                      <ArrowLeftToLine className="h-4 w-4" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.button>
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
