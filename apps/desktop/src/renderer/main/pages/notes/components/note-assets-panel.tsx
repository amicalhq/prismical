import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ClipboardCopy,
  FileText,
  Maximize2,
  Minimize2,
  MoreVertical,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSkillDiffToastStore } from "@/renderer/main/components/editor/diff/skill-diff-toast-store";
import { useNoteEditor } from "@/renderer/main/components/note-editor-context";
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

function formatTranscriptAsText(transcript: TranscriptEvent[]): string {
  return transcript
    .map(
      (segment) =>
        `[${getSpeakerLabel(segment)} ${formatTimestamp(segment.startTimeMs)}] ${segment.text}`,
    )
    .join("\n");
}

function buildTranscriptParagraphs(transcript: TranscriptEvent[]) {
  return transcript.map((segment) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: `${getSpeakerLabel(segment)} ${formatTimestamp(segment.startTimeMs)}: ${segment.text}`,
      },
    ],
  }));
}

type NoteAssetsPanelProps = {
  activeAsset: NoteAssetKind;
  isOpen: boolean;
  onClose: () => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  transcript: TranscriptEvent[];
  meetingState: MeetingRuntimeState;
};

export function NoteAssetsPanel({
  activeAsset,
  isOpen,
  onClose,
  isExpanded,
  onToggleExpanded,
  transcript,
  meetingState,
}: NoteAssetsPanelProps) {
  const { t } = useTranslation();
  const noteEditor = useNoteEditor();
  const [isContentVisible, setIsContentVisible] = useState(isOpen);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const prevTranscriptLenRef = useRef(transcript.length);
  const isStuckToBottomRef = useRef(true);

  const hasTranscript = transcript.length > 0;

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(formatTranscriptAsText(transcript));
      toast.success(t("settings.notes.note.transcriptionMenu.copied"));
    } catch {
      toast.error(t("settings.notes.note.transcriptionMenu.copyFailed"));
    }
  };

  const handleAddToNote = () => {
    if (!noteEditor) {
      toast.error(t("settings.notes.note.transcriptionMenu.addFailed"));
      return;
    }
    const { editor } = noteEditor;
    // When a skill-diff candidate is staged for this note the editor lock
    // rejects the docChanged transaction (see skill-diff-editor-lock.ts).
    // `.run()` returns false in that case — surface it instead of toasting
    // success against a no-op, and pulse the diff bar so the user looks at
    // it (matches the user-input attention path).
    const ok = editor
      .chain()
      .insertContentAt(
        editor.state.doc.content.size,
        buildTranscriptParagraphs(transcript),
      )
      .run();
    if (!ok) {
      useSkillDiffToastStore.getState().pulseAttention();
      toast.error(t("settings.notes.note.transcriptionMenu.addBlocked"));
      return;
    }
    toast.success(t("settings.notes.note.transcriptionMenu.added"));
  };

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

  // Track whether user is scrolled near the bottom
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      isStuckToBottomRef.current = scrollHeight - scrollTop - clientHeight < 40;
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll to bottom when new segments arrive (only if stuck to bottom)
  useEffect(() => {
    if (
      transcript.length > prevTranscriptLenRef.current &&
      isOpen &&
      isStuckToBottomRef.current
    ) {
      const timer = setTimeout(() => {
        scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
      prevTranscriptLenRef.current = transcript.length;
      return () => clearTimeout(timer);
    }
    prevTranscriptLenRef.current = transcript.length;
  }, [transcript.length, isOpen]);

  // Scroll to bottom when panel opens with existing transcript
  useEffect(() => {
    if (isContentVisible && transcript.length > 0) {
      isStuckToBottomRef.current = true;
      const timer = setTimeout(() => {
        scrollEndRef.current?.scrollIntoView({ behavior: "auto" });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isContentVisible]);

  switch (activeAsset) {
    case "transcription": {
      const isProcessing =
        meetingState === "starting" ||
        meetingState === "recording" ||
        meetingState === "stopping";

      return (
        <div className="flex h-full min-h-0">
          <div
            className={`flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl bg-black/80 dark:bg-black/70 backdrop-blur-md transition-[opacity,transform,box-shadow] duration-120 ease-out ${
              isOpen
                ? "translate-x-0 opacity-100 shadow-[0_1px_4px_rgba(0,0,0,0.15)]"
                : "translate-x-2 opacity-0 shadow-none"
            }`}
          >
            <div
              className={`flex items-center justify-between gap-3 px-4 py-2.5 transition-opacity duration-100 ${
                isContentVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="min-w-0 truncate text-sm font-semibold text-white">
                  {t("settings.notes.note.transcription")}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white"
                  onClick={onToggleExpanded}
                  aria-label={isExpanded ? "Shrink transcription" : "Expand transcription"}
                  title={isExpanded ? "Shrink" : "Expand"}
                >
                  {isExpanded ? (
                    <Minimize2 className="h-4 w-4" />
                  ) : (
                    <Maximize2 className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white"
                  onClick={onClose}
                  aria-label={t("settings.notes.note.actions.minimizeTranscription")}
                  title={t("settings.notes.note.actions.minimizeTranscription")}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-white/70 hover:bg-white/15 hover:text-white disabled:opacity-40"
                      aria-label={t("settings.notes.note.transcriptionMenu.trigger")}
                      title={t("settings.notes.note.transcriptionMenu.trigger")}
                      disabled={!hasTranscript}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="gap-2"
                      onSelect={handleCopyTranscript}
                    >
                      <ClipboardCopy className="h-4 w-4" />
                      {t("settings.notes.note.transcriptionMenu.copy")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="gap-2"
                      disabled={!noteEditor}
                      onSelect={handleAddToNote}
                    >
                      <FileText className="h-4 w-4" />
                      {t("settings.notes.note.transcriptionMenu.addToNote")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <ScrollArea
              className="min-h-0 flex-1"
              type="scroll"
              scrollBarClassName={SCROLLBAR_WHILE_SCROLLING_CLASS}
              viewportRef={viewportRef}
            >
              <div
                className={`flex flex-col gap-2 px-3 pt-3 pb-2 transition-[opacity,transform] duration-120 ${
                  isContentVisible
                    ? "translate-x-0 opacity-100"
                    : "translate-x-2 opacity-0"
                }`}
              >
                {transcript.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-white/60">
                    {isProcessing
                      ? "Meeting transcription will appear here."
                      : "Start a meeting from the dock to capture transcript here."}
                  </div>
                ) : null}
                <AnimatePresence initial={false}>
                  {transcript.map((segment, i) => {
                    const isUser = segment.speaker === "you";
                    const prevSegment = i > 0 ? transcript[i - 1] : null;
                    const sameSpeakerAsPrev =
                      prevSegment?.speaker === segment.speaker;

                    return (
                      <motion.div
                        key={segment.id}
                        initial={{ opacity: 0, y: 8, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{
                          duration: 0.25,
                          ease: [0.25, 0.46, 0.45, 0.94],
                        }}
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
                                className={`text-[11px] font-medium ${isUser ? "text-white/70" : "text-emerald-400"}`}
                              >
                                {getSpeakerLabel(segment)}
                              </span>
                              <span className="text-[10px] tabular-nums text-white/40">
                                {formatTimestamp(segment.startTimeMs)}
                              </span>
                            </div>
                          )}
                          <div
                            className={`rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed ${
                              isUser
                                ? "bg-white text-neutral-900 dark:bg-white/90 rounded-br-md"
                                : "bg-white/15 text-white dark:bg-white/10 rounded-bl-md"
                            }`}
                          >
                            {segment.text}
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                <div ref={scrollEndRef} aria-hidden />
              </div>
            </ScrollArea>
            {meetingState === "stopping" && (
              <div className="flex shrink-0 items-center justify-center gap-2.5 px-4 py-3">
                <div className="flex gap-1" aria-hidden>
                  <span className="h-2 w-2 animate-pulse rounded-full bg-white/60 [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-pulse rounded-full bg-white/60 [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-pulse rounded-full bg-white/60" />
                </div>
                <span className="ai-generating-text shimmer-text-light text-sm font-medium">
                  Transcribing the last bits…
                </span>
              </div>
            )}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}
