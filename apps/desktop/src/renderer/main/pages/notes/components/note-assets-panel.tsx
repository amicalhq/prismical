import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { MeetingRuntimeState, TranscriptEvent } from "@/types/meeting";
import type { NoteAssetKind } from "../types";

const SCROLLBAR_WHILE_SCROLLING_CLASS =
  "data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100 transition-opacity duration-150";
const TRANSCRIPTION_CONTENT_SHOW_DELAY_MS = 120;

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getSpeakerLabel(event: TranscriptEvent): string {
  return event.speaker === "you" ? "You" : "Them";
}

type NoteAssetsPanelProps = {
  activeAsset: NoteAssetKind;
  isOpen: boolean;
  onClose: () => void;
  transcript: TranscriptEvent[];
  meetingState: MeetingRuntimeState;
};

export function NoteAssetsPanel({
  activeAsset,
  isOpen,
  onClose,
  transcript,
  meetingState,
}: NoteAssetsPanelProps) {
  const { t } = useTranslation();
  const [isContentVisible, setIsContentVisible] = useState(isOpen);

  useEffect(() => {
    if (!isOpen) {
      setIsContentVisible(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsContentVisible(true);
    }, TRANSCRIPTION_CONTENT_SHOW_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isOpen]);

  switch (activeAsset) {
    case "transcription": {
      const isProcessing =
        meetingState === "starting" ||
        meetingState === "recording" ||
        meetingState === "stopping";

      return (
        <div className="flex h-full min-h-0">
          <div
            className={`flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border bg-card transition-[opacity,transform,border-color,box-shadow] duration-120 ease-out ${
              isOpen
                ? "translate-x-0 opacity-100 border-border/70 shadow-sm"
                : "translate-x-2 opacity-0 border-border/0 shadow-none"
            }`}
          >
            <div
              className={`flex items-center justify-between gap-3 bg-muted/45 px-4 py-2.5 transition-opacity duration-100 ${
                isContentVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              <h2 className="min-w-0 truncate text-sm font-semibold">
                {t("settings.notes.note.transcription")}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={onClose}
                aria-label={t("settings.notes.note.actions.closeTranscription")}
                title={t("settings.notes.note.actions.closeTranscription")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <ScrollArea
              className="min-h-0 flex-1"
              type="scroll"
              scrollBarClassName={SCROLLBAR_WHILE_SCROLLING_CLASS}
            >
              <div
                className={`flex flex-col gap-2 px-3 pt-3 pb-2 transition-[opacity,transform] duration-120 ${
                  isContentVisible
                    ? "translate-x-0 opacity-100"
                    : "translate-x-2 opacity-0"
                }`}
              >
                {transcript.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                    {isProcessing
                      ? "Meeting transcription will appear here."
                      : "Start a meeting from the dock to capture transcript here."}
                  </div>
                ) : null}
                {transcript.map((segment, i) => {
                  const isUser = segment.speaker === "you";
                  const prevSegment = i > 0 ? transcript[i - 1] : null;
                  const sameSpeakerAsPrev =
                    prevSegment?.speaker === segment.speaker;

                  return (
                    <div
                      key={segment.id}
                      className={`flex ${isUser ? "justify-end" : "justify-start"} ${sameSpeakerAsPrev ? "" : "mt-1"}`}
                    >
                      <div
                        className={`max-w-[85%] ${isUser ? "items-end" : "items-start"}`}
                      >
                        {!sameSpeakerAsPrev && (
                          <div
                            className={`mb-0.5 flex items-center gap-1.5 px-1 ${isUser ? "flex-row-reverse" : "flex-row"}`}
                          >
                            <span
                              className={`text-[11px] font-medium ${isUser ? "text-muted-foreground" : "text-emerald-400"}`}
                            >
                              {getSpeakerLabel(segment)}
                            </span>
                            <span className="text-[10px] tabular-nums text-muted-foreground/60">
                              {formatTimestamp(segment.startTimeMs)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed ${
                            isUser
                              ? "bg-primary text-primary-foreground rounded-br-md"
                              : "bg-muted/70 text-foreground rounded-bl-md"
                          }`}
                        >
                          {segment.text}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}
