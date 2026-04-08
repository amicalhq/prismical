import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { api, trpcClient } from "@/trpc/react";
import type { MeetingWidgetState } from "@/types/meeting-widget";
import "@/styles/globals.css";

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

function RecordingWidgetWindow() {
  const initialStateQuery = api.meetingWidget.getState.useQuery();
  const [liveState, setLiveState] = useState<MeetingWidgetState | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const interactiveRef = useRef(false);

  api.meetingWidget.stateUpdates.useSubscription(undefined, {
    onData: (nextState) => {
      setLiveState(nextState);
    },
  });

  const state = liveState ?? initialStateQuery.data ?? null;
  const widgetVisible = state?.visible ?? false;
  const meetingState = state?.meetingState ?? "idle";
  const isInteractive = isHovered || dragState !== null;
  const widgetTone = useMemo(() => {
    if (meetingState === "error") {
      return {
        shell:
          "bg-[rgba(150,28,28,0.94)] border-white/12 shadow-[0_18px_40px_rgba(120,13,13,0.4)]",
        ring: "from-red-400/40 via-red-300/10 to-transparent",
        accent: "bg-red-300/85",
      };
    }

    return {
      shell:
        "bg-[rgba(12,14,18,0.95)] border-white/12 shadow-[0_18px_40px_rgba(3,6,14,0.42)]",
      ring: "from-sky-200/28 via-white/8 to-transparent",
      accent: "bg-white/80",
    };
  }, [meetingState]);

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

  const handleOpenNote = useCallback(() => {
    void window.electronAPI.recordingWidget.openNote();
  }, []);

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragState({
        pointerOffsetY: event.clientY,
      });
      setIsHovered(true);
    },
    [],
  );

  const bars = useMemo(
    () =>
      Array.from({ length: 4 }, (_, index) => ({
        id: index,
        duration: 0.78 + index * 0.12,
        delay: index * 0.08,
      })),
    [],
  );

  const showHandle = isHovered || dragState !== null;

  return (
    <main
      className="h-screen w-screen bg-transparent"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex h-full w-full items-center justify-center bg-transparent">
        <motion.div
          initial={false}
          animate={
            widgetVisible
              ? { opacity: 1, x: 0, scale: 1 }
              : { opacity: 0, x: 24, scale: 0.96 }
          }
          transition={{
            type: "spring",
            stiffness: 280,
            damping: 26,
            mass: 0.7,
          }}
          className="pointer-events-none flex w-full flex-col items-end pr-1"
        >
          <button
            type="button"
            data-hit-zone="true"
            onClick={handleOpenNote}
            className={`pointer-events-auto relative flex h-[78px] w-[78px] items-center justify-center overflow-hidden rounded-full border backdrop-blur-xl transition-transform duration-150 ${widgetTone.shell} ${widgetVisible ? "scale-100" : "scale-95"}`}
            aria-label="Open current meeting note"
          >
            <div
              className={`pointer-events-none absolute inset-[1px] rounded-full bg-linear-to-br ${widgetTone.ring}`}
            />
            <div className="pointer-events-none absolute inset-[8px] rounded-full border border-white/8" />
            <div className="pointer-events-none absolute inset-x-4 top-2 h-8 rounded-full bg-white/5 blur-xl" />
            <div className="relative z-10 flex flex-col items-center gap-1">
              <img
                src="/assets/icon_logo.svg"
                alt=""
                className="h-4 w-4 opacity-80"
                draggable={false}
              />
              {meetingState === "starting" ? (
                <Loader2 className="h-5 w-5 animate-spin text-white/80" />
              ) : (
                <div className="flex h-6 items-end gap-[3px]">
                  {bars.map((bar) => (
                    <motion.div
                      key={bar.id}
                      className={`w-[4px] rounded-full ${widgetTone.accent}`}
                      initial={false}
                      animate={
                        meetingState === "recording"
                          ? {
                              height: ["20%", "100%", "35%", "72%", "26%"],
                              opacity: [0.55, 1, 0.65, 0.92, 0.6],
                            }
                          : {
                              height: "48%",
                              opacity: 0.7,
                            }
                      }
                      transition={
                        meetingState === "recording"
                          ? {
                              duration: bar.duration,
                              repeat: Number.POSITIVE_INFINITY,
                              ease: "easeInOut",
                              delay: bar.delay,
                            }
                          : {
                              duration: 0.2,
                            }
                      }
                      style={{ transformOrigin: "bottom center" }}
                    />
                  ))}
                </div>
              )}
            </div>
          </button>

          <motion.button
            type="button"
            data-hit-zone="true"
            onPointerDown={handleDragStart}
            initial={false}
            animate={{
              opacity: showHandle ? 1 : 0,
              y: showHandle ? 0 : -6,
            }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="pointer-events-auto mt-2 flex h-[22px] w-[34px] items-center justify-center rounded-full border border-white/10 bg-[rgba(12,14,18,0.72)] text-white/45 shadow-[0_10px_24px_rgba(3,6,14,0.28)] backdrop-blur-md"
            aria-label="Drag recording widget"
          >
            <div className="grid grid-cols-3 gap-[3px]">
              {Array.from({ length: 6 }).map((_, index) => (
                <span
                  key={index}
                  className="h-[3px] w-[3px] rounded-full bg-current"
                />
              ))}
            </div>
          </motion.button>
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
