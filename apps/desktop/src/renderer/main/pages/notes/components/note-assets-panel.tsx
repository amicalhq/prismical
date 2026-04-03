import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  NoteAssetKind,
  TranscriptionData,
  TranscriptionSpeaker,
} from "../types";

const SCROLLBAR_WHILE_SCROLLING_CLASS =
  "data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100 transition-opacity duration-150";
const TRANSCRIPTION_CONTENT_SHOW_DELAY_MS = 120;

const SPEAKER_COLORS = [
  "text-blue-400",
  "text-emerald-400",
  "text-amber-400",
  "text-purple-400",
  "text-rose-400",
  "text-cyan-400",
];

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getSpeakerLabel(speaker: TranscriptionSpeaker): string {
  if (speaker.name) return speaker.name;
  if (speaker.isUser) return "You";
  return `Speaker ${speaker.index + 1}`;
}

const MOCK_TRANSCRIPTION: TranscriptionData = {
  speakers: [
    { index: 0, name: "You", isUser: true },
    { index: 1, name: "Sarah" },
    { index: 2 },
  ],
  segments: [
    {
      speaker: 0,
      start: 0,
      end: 6.2,
      text: "Welcome back. Today I want to walk through the customer interview notes and pull out the themes that kept repeating.",
    },
    {
      speaker: 1,
      start: 7.0,
      end: 14.8,
      text: "Sure. The biggest friction point was handoff. People could capture ideas quickly, but once they had to organize or share them, the workflow broke down.",
    },
    {
      speaker: 0,
      start: 15.2,
      end: 16.1,
      text: "Right.",
    },
    {
      speaker: 1,
      start: 16.5,
      end: 24.3,
      text: "A split view could help because the source material stays visible while the final note remains editable on the other side.",
    },
    {
      speaker: 2,
      start: 25.0,
      end: 33.1,
      text: "I'd add that we should keep the transcript readable and easy to scan. If it turns into a dense utility panel, people won't use it.",
    },
    {
      speaker: 0,
      start: 33.8,
      end: 42.5,
      text: "Agreed. For this first pass the goal is layout. We can hardcode the content now and wire it to real data later.",
    },
  ],
};

type NoteAssetsPanelProps = {
  activeAsset: NoteAssetKind;
  isOpen: boolean;
  onClose: () => void;
};

export function NoteAssetsPanel({
  activeAsset,
  isOpen,
  onClose,
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
      const { speakers, segments } = MOCK_TRANSCRIPTION;
      const speakerMap = new Map(speakers.map((s) => [s.index, s]));

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
                {segments.map((segment, i) => {
                  const speaker = speakerMap.get(segment.speaker);
                  const isUser = speaker?.isUser ?? false;
                  const colorClass =
                    SPEAKER_COLORS[segment.speaker % SPEAKER_COLORS.length];
                  const prevSegment = i > 0 ? segments[i - 1] : null;
                  const sameSpeakerAsPrev =
                    prevSegment?.speaker === segment.speaker;

                  return (
                    <div
                      key={i}
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
                              className={`text-[11px] font-medium ${isUser ? "text-muted-foreground" : colorClass}`}
                            >
                              {speaker
                                ? getSpeakerLabel(speaker)
                                : `Speaker ${segment.speaker + 1}`}
                            </span>
                            <span className="text-[10px] tabular-nums text-muted-foreground/60">
                              {formatTimestamp(segment.start)}
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
