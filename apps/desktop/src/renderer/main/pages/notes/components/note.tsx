import { useEffect, useState, type ReactNode } from "react";
import {
  Calendar,
  FileTextIcon,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Star,
  Trash2,
} from "lucide-react";
import EmojiPicker, { Theme } from "emoji-picker-react";
import { IconNotes, IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CreateFolderDialog } from "@/renderer/main/components/create-folder-dialog";
import { FolderPickerDialog } from "@/renderer/main/components/folder-picker-dialog";
import { useSettingsHeaderActions } from "@/renderer/main/routes/settings/header-actions-context";

import { NoteAssetsPanel } from "./note-assets-panel";
import { NoteRecordingDock } from "./note-recording-dock";
import type { NoteAssetKind } from "../types";
import type { MeetingRuntimeState, TranscriptEvent } from "@/types/meeting";
import {
  formatEventTimeRange,
  getEventDateLabel,
} from "@/utils/event-time";
import {
  getMeetingIcon,
  getMeetingPlatformDisplayName,
} from "@/utils/meeting-icons";

export type NoteTab = "summary" | "raw";

export type NoteEventData = {
  eventId: string;
  title: string;
  calendarColor: string;
  meetingUrl?: string;
  calendarEventUrl?: string;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
};

export type NotePageUIProps = {
  noteTitle: string;
  noteEmoji: string | null;
  noteStarred: boolean;
  noteFolder: string | null;
  noteUpdatedAt: Date;
  eventData: NoteEventData | null;
  folderOptions: string[];
  isLoading: boolean;
  activeAsset: NoteAssetKind | null;
  onToggleAsset: (asset: NoteAssetKind) => void;
  onTitleChange: (value: string) => void;
  onDelete: () => void;
  onEmojiChange: (emoji: string | null) => void;
  onStarredChange: (starred: boolean) => void;
  onFolderChange: (folder: string | null) => void;
  meetingState: MeetingRuntimeState;
  transcript: TranscriptEvent[];
  onStartMeeting: () => void;
  onStopMeeting: () => void;
  onGenerateNotes: () => void;
  isGeneratingNotes: boolean;
  activeTab: NoteTab;
  onActiveTabChange: (tab: NoteTab) => void;
  showTabSwitcher: boolean;
  isDeleting?: boolean;
  children?: ReactNode;
};

const SCROLLBAR_WHILE_SCROLLING_CLASS =
  "data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100 transition-opacity duration-150";

// Cheap relative-time formatter — ticks once a minute so "Edited 5 min ago"
// stays roughly correct without a dependency like date-fns.
function formatRelativeTime(date: Date, locale: string): string {
  const now = new Date();
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (diffSeconds < 60) return rtf.format(0, "second");
  const diffMins = Math.floor(diffSeconds / 60);
  if (diffMins < 60) return rtf.format(-diffMins, "minute");
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return rtf.format(-diffHours, "hour");

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  ) {
    return rtf.format(-1, "day");
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  }).format(date);
}


export default function Note({
  noteTitle,
  noteEmoji,
  noteStarred,
  noteFolder,
  noteUpdatedAt,
  eventData,
  folderOptions,
  isLoading,
  activeAsset,
  onToggleAsset,
  onTitleChange,
  onDelete,
  onEmojiChange,
  onStarredChange,
  onFolderChange,
  meetingState,
  transcript,
  onStartMeeting,
  onStopMeeting,
  onGenerateNotes,
  isGeneratingNotes,
  activeTab,
  onActiveTabChange,
  showTabSwitcher,
  isDeleting = false,
  children,
}: NotePageUIProps) {
  const { t, i18n } = useTranslation();
  const { setActions, setHeaderContent } = useSettingsHeaderActions();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  // Re-render once a minute so the "Edited X ago" label stays fresh without
  // each edit having to round-trip through state.
  const [, setRelativeTimeTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setRelativeTimeTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setHeaderContent(null);
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  useEffect(() => {
    setActions(null);
    return () => setActions(null);
  }, [setActions]);

  const handleDeleteClick = () => {
    setShowDeleteDialog(false);
    onDelete();
  };

  const handleCreateFolder = () => {
    setShowCreateFolderDialog(true);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isTranscriptionOpen = activeAsset === "transcription";

  const notePane = (
    <div className="relative h-full min-h-0 bg-background">
      <ScrollArea
        className="h-full"
        type="scroll"
        scrollBarClassName={SCROLLBAR_WHILE_SCROLLING_CLASS}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col px-6 pb-32 pt-6">
          <div className="mb-1 flex items-center">
            <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="!h-12 !w-12 shrink-0 !p-0 hover:bg-muted/50"
                >
                  {noteEmoji ? (
                    <span className="text-2xl">{noteEmoji}</span>
                  ) : (
                    <FileTextIcon className="!h-6 !w-6 text-muted-foreground" />
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div>
                  {noteEmoji ? (
                    <div className="flex justify-end border-b p-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onEmojiChange(null)}
                        className="text-xs"
                      >
                        {t("settings.notes.note.removeEmoji")}
                      </Button>
                    </div>
                  ) : null}
                  <EmojiPicker
                    onEmojiClick={(emojiData) => {
                      onEmojiChange(emojiData.emoji);
                      setShowEmojiPicker(false);
                    }}
                    autoFocusSearch={false}
                    theme={Theme.DARK}
                    lazyLoadEmojis={false}
                    height={400}
                    width={400}
                  />
                </div>
              </PopoverContent>
            </Popover>

            <Input
              value={noteTitle}
              onChange={(event) => onTitleChange(event.target.value)}
              className="flex-1 !h-auto !bg-transparent dark:!bg-transparent px-4 py-2 !text-4xl font-semibold !border-0 !shadow-none placeholder:text-muted-foreground focus-visible:!border-0 focus-visible:!ring-0"
              placeholder={t("settings.notes.note.titlePlaceholder")}
            />
          </div>

          <div className="mb-6 flex flex-col gap-0.5 bg-card pl-4">
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-sm text-muted-foreground">
                  {t("settings.notes.note.edited", {
                    date: formatRelativeTime(noteUpdatedAt, i18n.language),
                  })}
                </span>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-2"
                      onClick={() => onStarredChange(!noteStarred)}
                    >
                      <Star
                        className={`h-4 w-4 ${
                          noteStarred ? "fill-yellow-400 text-yellow-400" : ""
                        }`}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {noteStarred
                      ? t("settings.notes.note.actions.removeFromFavorites")
                      : t("settings.notes.note.actions.addToFavorites")}
                  </TooltipContent>
                </Tooltip>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="gap-2"
                      onSelect={() => setShowFolderPicker(true)}
                    >
                      <FolderOpen className="h-4 w-4" />
                      {t("settings.notes.note.actions.moveToFolder")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="gap-2"
                      variant="destructive"
                      onSelect={() => setShowDeleteDialog(true)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                      {t("settings.notes.note.actions.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {eventData ? (
                <div className="@container/event-chip flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
                  <Calendar
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: eventData.calendarColor }}
                  />
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-auto max-w-full px-1.5 py-0.5 text-sm font-normal text-muted-foreground hover:text-foreground"
                        title={eventData.title}
                      >
                        <span className="truncate">
                          {eventData.title.length > 30
                            ? `${eventData.title.slice(0, 30).trimEnd()}…`
                            : eventData.title}
                        </span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="bottom"
                      align="start"
                      sideOffset={6}
                      className="w-80 p-0"
                    >
                    <div className="flex items-start gap-3 p-3">
                      <span
                        className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: eventData.calendarColor }}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground">
                          {getEventDateLabel(eventData.startAt, t)}{" "}
                          <span aria-hidden="true">•</span>{" "}
                          {formatEventTimeRange(
                            eventData.startAt,
                            eventData.endAt,
                            eventData.isAllDay,
                            i18n.language,
                          )}
                        </p>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium leading-tight">
                            {eventData.title}
                          </p>
                          {eventData.meetingUrl
                            ? getMeetingIcon(eventData.meetingUrl, {
                                className:
                                  "h-3.5 w-3.5 text-muted-foreground shrink-0",
                              })
                            : null}
                        </div>

                        {(eventData.meetingUrl ||
                          eventData.calendarEventUrl) && (
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {eventData.meetingUrl ? (
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                onClick={() =>
                                  window.electronAPI.openExternal(
                                    eventData.meetingUrl!,
                                  )
                                }
                              >
                                {getMeetingIcon(eventData.meetingUrl, {
                                  className: "mr-1 h-3.5 w-3.5",
                                })}
                                {(() => {
                                  const platform = getMeetingPlatformDisplayName(
                                    eventData.meetingUrl,
                                  );
                                  const joinLabel = t(
                                    "settings.home.upcoming.join",
                                  );
                                  return platform
                                    ? `${joinLabel} ${platform}`
                                    : joinLabel;
                                })()}
                              </Button>
                            ) : null}
                            {eventData.calendarEventUrl ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 px-2.5 text-xs"
                                onClick={() =>
                                  window.electronAPI.openExternal(
                                    eventData.calendarEventUrl!,
                                  )
                                }
                              >
                                Open in calendar
                              </Button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
                  <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    <span className="h-1 w-1 rounded-full bg-muted-foreground @max-[420px]/event-chip:hidden" />
                    <span className="text-xs">
                      {formatEventTimeRange(
                        eventData.startAt,
                        eventData.endAt,
                        eventData.isAllDay,
                        i18n.language,
                      )}
                    </span>
                  </span>
                </div>
              ) : null}
            </div>
          {children}
        </div>
      </ScrollArea>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10">
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-2 px-6">
          <div
            className={`w-full max-w-md overflow-hidden transition-all duration-200 ease-out ${
              isTranscriptionOpen
                ? "pointer-events-auto h-[50vh] opacity-100"
                : "pointer-events-none h-0 opacity-0"
            }`}
          >
            <NoteAssetsPanel
              activeAsset="transcription"
              isOpen={isTranscriptionOpen}
              onClose={() => onToggleAsset("transcription")}
              transcript={transcript}
              meetingState={meetingState}
              onGenerateNotes={onGenerateNotes}
              isGeneratingNotes={isGeneratingNotes}
            />
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            <NoteRecordingDock
              isTranscriptionOpen={isTranscriptionOpen}
              onToggleTranscription={() => onToggleAsset("transcription")}
              meetingState={meetingState}
              onStartMeeting={onStartMeeting}
              onStopMeeting={onStopMeeting}
            />
            {showTabSwitcher ? (
              <div className="flex h-[42px] w-[78px] items-center justify-center gap-1 rounded-full bg-black/80 p-[5px] backdrop-blur-md ring-[1px] ring-black/60 shadow-[0px_0px_15px_0px_rgba(0,0,0,0.40)] transition-all duration-200 ease-out hover:scale-110 dark:bg-black/70">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`!h-8 !w-8 rounded-full !p-0 text-white/70 hover:bg-white/15 hover:text-white ${
                    activeTab === "raw" ? "bg-white/15 text-white" : ""
                  }`}
                  onClick={() => onActiveTabChange("raw")}
                  aria-label="Raw notes"
                  title="Raw notes"
                >
                  <IconNotes className="!h-[18px] !w-[18px]" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`!h-8 !w-8 rounded-full !p-0 text-white/70 hover:bg-white/15 hover:text-white ${
                    activeTab === "summary" ? "bg-white/15 text-white" : ""
                  }`}
                  onClick={() => onActiveTabChange("summary")}
                  aria-label="AI Summary"
                  title="AI Summary"
                >
                  <IconSparkles className="!h-[18px] !w-[18px]" />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-full w-full min-h-0">
      {notePane}

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.notes.note.deleteDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.notes.note.deleteDialog.description", {
                title: noteTitle,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.notes.note.deleteDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteClick}
              className="bg-destructive text-foreground hover:bg-destructive/90"
              disabled={isDeleting}
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("settings.notes.note.deleteDialog.deleting")}
                </>
              ) : (
                t("settings.notes.note.deleteDialog.confirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <FolderPickerDialog
        open={showFolderPicker}
        onOpenChange={setShowFolderPicker}
        currentFolder={noteFolder}
        folderNames={folderOptions}
        onFolderChange={onFolderChange}
        onCreateFolder={handleCreateFolder}
      />

      <CreateFolderDialog
        open={showCreateFolderDialog}
        onOpenChange={setShowCreateFolderDialog}
        onConfirm={(folderName) => onFolderChange(folderName)}
      />
    </div>
  );
}
