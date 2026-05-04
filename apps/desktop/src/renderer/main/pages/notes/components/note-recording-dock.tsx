import { Mic, Square, ChevronUp } from "lucide-react";
import { Waveform } from "@/components/Waveform";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { MeetingRuntimeState } from "@/types/meeting";

const NUM_WAVEFORM_BARS = 6;

type NoteRecordingDockProps = {
  isTranscriptionOpen?: boolean;
  onToggleTranscription?: () => void;
  meetingState: MeetingRuntimeState;
  // Real-time audio amplitude in [0, 1] (combined mic + system). Owned by
  // the parent via useMeetingLevel so a single subscription feeds every
  // dock instance.
  level: number;
  onStartMeeting: () => void;
  onStopMeeting: () => void;
};

export function NoteRecordingDock({
  isTranscriptionOpen = false,
  onToggleTranscription,
  meetingState,
  level,
  onStartMeeting,
  onStopMeeting,
}: NoteRecordingDockProps) {
  // "stopping" is excluded so the dock collapses back to its idle pill the
  // moment Stop is clicked — finalisation work continues in the background and
  // is surfaced via a "Transcribing…" indicator inside the transcription panel.
  const isRecording =
    meetingState === "recording" || meetingState === "starting";
  const isBusy = meetingState === "starting" || meetingState === "stopping";

  const handleMicClick = () => {
    if (!isBusy) {
      onStartMeeting();
    }
  };

  const handleStopClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isBusy) {
      onStopMeeting();
    }
  };

  return (
    <div
      className={`
        group
        transition-all duration-200 ease-out overflow-hidden
        h-[42px] hover:scale-110
        ${isRecording ? "w-[160px]" : onToggleTranscription ? "w-[78px] hover:w-[86px]" : "w-[56px] hover:w-[64px]"}
        bg-black/80 dark:bg-black/70 rounded-[28px] backdrop-blur-md
        ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)]
        relative select-none
        flex items-center justify-center
      `}
    >
      {/* Idle state — Mic + Chevron, delays showing when closing */}
      <div
        className={`
          absolute inset-0 flex items-center justify-center gap-1 p-[5px]
          transition-opacity
          ${isRecording ? "opacity-0 duration-75 delay-0 pointer-events-none" : "opacity-100 duration-100 delay-100"}
        `}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleMicClick}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full cursor-pointer text-white/70 transition-colors hover:bg-white/15 hover:text-white active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Start recording"
              disabled={isBusy}
            >
              <Mic className="w-[18px] h-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Start recording</TooltipContent>
        </Tooltip>
        {onToggleTranscription && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleTranscription}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full cursor-pointer text-white/50 transition-colors hover:bg-white/15 hover:text-white/80"
                aria-label={
                  isTranscriptionOpen
                    ? "Hide transcription"
                    : "Show transcription"
                }
              >
                <ChevronUp
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${
                    isTranscriptionOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {isTranscriptionOpen
                ? "Hide transcription"
                : "Show transcription"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Recording controls — visible when recording, hides fast when closing */}
      <div
        className={`
          flex h-full w-full items-center justify-center gap-3 pl-7 pr-5
          transition-opacity
          ${isRecording ? "opacity-100 duration-100 delay-75" : "opacity-0 duration-50 delay-0 pointer-events-none"}
        `}
      >
        <div className="flex items-center gap-1 h-full">
          {Array.from({ length: NUM_WAVEFORM_BARS }).map((_, index) => (
            <Waveform
              key={index}
              index={index}
              isRecording={isRecording}
              level={level}
              baseHeight={60}
              silentHeight={20}
            />
          ))}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleStopClick}
              className="flex-shrink-0 flex items-center justify-center p-1.5 rounded-full hover:bg-white/15 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Stop recording"
              disabled={isBusy}
            >
              <Square className="w-[18px] h-[18px] text-red-500 fill-red-500" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Stop recording</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
