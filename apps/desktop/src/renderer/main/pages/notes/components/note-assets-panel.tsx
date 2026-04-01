import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { NoteAssetKind } from "../types";

const SCROLLBAR_WHILE_SCROLLING_CLASS =
  "data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100 transition-opacity duration-150";
const TRANSCRIPTION_CONTENT_SHOW_DELAY_MS = 120;

const MOCK_TRANSCRIPTION_SEGMENTS = [
  {
    time: "00:00",
    text: "Welcome back. Today I want to walk through the customer interview notes and pull out the themes that kept repeating across the conversations.",
  },
  {
    time: "00:24",
    text: "The biggest friction point was handoff. People could capture ideas quickly, but once they had to organize or share them, the workflow became fragmented.",
  },
  {
    time: "00:53",
    text: "A split view could help here because the source material stays visible while the final note remains editable and independent on the left.",
  },
  {
    time: "01:19",
    text: "We should keep the transcript readable, lightly structured, and easy to scan instead of turning it into a dense utility panel.",
  },
  {
    time: "01:47",
    text: "For this first pass, the goal is purely layout. We can hardcode the content now and replace it with real note-linked transcription data later.",
  },
];

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
    case "transcription":
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
              className={`flex items-center justify-between gap-3 bg-muted/45 px-4 py-2.5 transition-opacity duration-100 md:px-5 ${
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
                className={`space-y-4 px-4 pt-4 pb-2 transition-[opacity,transform] duration-120 ${
                  isContentVisible
                    ? "translate-x-0 opacity-100"
                    : "translate-x-2 opacity-0"
                }`}
              >
                {MOCK_TRANSCRIPTION_SEGMENTS.map((segment) => (
                  <section key={segment.time} className="space-y-1">
                    <div className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                      {segment.time}
                    </div>
                    <p className="text-sm leading-6 text-foreground">
                      {segment.text}
                    </p>
                  </section>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      );
    default:
      return null;
  }
}
