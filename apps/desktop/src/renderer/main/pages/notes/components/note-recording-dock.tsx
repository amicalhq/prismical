import { useState, useEffect, useRef } from "react";
import { Mic, Square } from "lucide-react";
import { Waveform } from "@/components/Waveform";

const NUM_WAVEFORM_BARS = 6;

export function NoteRecordingDock() {
  const [isRecording, setIsRecording] = useState(false);
  const [voiceDetected, setVoiceDetected] = useState(false);
  const voiceIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Simulate voice detection cycling for visual demo
  useEffect(() => {
    if (isRecording) {
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
      }
    };
  }, [isRecording]);

  const handleMicClick = () => {
    setIsRecording(true);
  };

  const handleStopClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsRecording(false);
  };

  return (
    <div
      onClick={!isRecording ? handleMicClick : undefined}
      className={`
        group
        transition-all duration-150 ease-out overflow-hidden
        h-[42px]
        ${isRecording ? "w-[160px]" : "w-[56px] hover:w-[64px]"}
        bg-black/80 dark:bg-black/70 rounded-[28px] backdrop-blur-md
        ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)]
        before:content-[''] before:absolute before:inset-[1px] before:rounded-[27px] before:outline before:outline-white/15 before:pointer-events-none
        relative cursor-pointer select-none
        flex items-center justify-center
        ${!isRecording ? "active:scale-95" : ""}
      `}
    >
      {/* Mic icon — visible when idle, delays showing when closing */}
      <div
        className={`
          absolute inset-0 flex items-center justify-center
          transition-opacity
          ${isRecording ? "opacity-0 duration-75 delay-0 pointer-events-none" : "opacity-100 duration-100 delay-100"}
        `}
      >
        <Mic className="w-[18px] h-[18px] text-white/70 group-hover:text-white transition-all duration-300" />
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
              voiceDetected={voiceDetected}
              baseHeight={60}
              silentHeight={20}
            />
          ))}
        </div>
        <button
          onClick={handleStopClick}
          className="flex-shrink-0 flex items-center justify-center p-1.5 rounded-full hover:bg-white/15 transition-colors cursor-pointer"
          aria-label="Stop recording"
        >
          <Square className="w-[18px] h-[18px] text-red-500 fill-red-500" />
        </button>
      </div>
    </div>
  );
}
