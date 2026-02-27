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
    <div className="fixed bottom-4 left-0 right-0 flex justify-center z-10 pointer-events-none">
      <div
        className={`
          pointer-events-auto
          transition-all duration-200 ease-in-out
          ${isRecording ? "h-[48px]" : "h-[48px] w-[64px]"}
          bg-black/70 rounded-[28px] backdrop-blur-md
          ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)]
          before:content-[''] before:absolute before:inset-[1px] before:rounded-[27px] before:outline before:outline-white/15 before:pointer-events-none
          relative cursor-pointer select-none
          flex items-center justify-center
        `}
      >
        {isRecording ? (
          <div className="flex h-full w-full items-center justify-center gap-3 pl-7 pr-5">
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
              className="flex-shrink-0 flex items-center justify-center p-1.5 rounded-full hover:bg-white/15 transition-colors"
              aria-label="Stop recording"
            >
              <Square className="w-[18px] h-[18px] text-red-500 fill-red-500" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleMicClick}
            className="flex items-center justify-center w-full h-full rounded-[28px] transition-colors"
            aria-label="Start recording"
          >
            <Mic className="w-[20px] h-[20px] text-white" />
          </button>
        )}
      </div>
    </div>
  );
}
