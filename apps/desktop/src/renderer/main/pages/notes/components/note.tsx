import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Calendar,
  FolderOpen,
  MoreHorizontal,
  PanelRight,
  PanelRightOpen,
  Star,
  Trash2,
  FileTextIcon,
  Loader2,
} from "lucide-react";
import EmojiPicker, { Theme } from "emoji-picker-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Toggle } from "@/components/ui/toggle";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useTranslation } from "react-i18next";
import { NoteRecordingDock } from "./note-recording-dock";
import { NoteAssetsPanel } from "./note-assets-panel";
import { CreateFolderDialog } from "@/renderer/main/components/create-folder-dialog";
import { FolderPickerDialog } from "@/renderer/main/components/folder-picker-dialog";
import type { NoteAssetKind } from "../types";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSettingsHeaderActions } from "@/renderer/main/routes/settings/header-actions-context";

export type NotePageUIProps = {
  noteTitle: string;
  noteEmoji: string | null;
  noteStarred: boolean;
  noteFolder: string | null;
  folderOptions: string[];
  isLoading: boolean;
  isSyncing: boolean;
  lastEditDate: Date;
  eventData?: {
    eventId: string;
    title: string;
    calendarColor: string;
    meetingUrl?: string;
    calendarEventUrl?: string;
    startTime?: string;
    endTime?: string;
    date?: string;
  } | null;
  activeAsset: NoteAssetKind | null;
  panelLayout: [number, number];
  onPanelLayoutChange: (layout: [number, number]) => void;
  onToggleAsset: (asset: NoteAssetKind) => void;
  onTitleChange: (value: string) => void;
  onDelete: () => void;
  onEmojiChange: (emoji: string | null) => void;
  onStarredChange: (starred: boolean) => void;
  onFolderChange: (folder: string | null) => void;
  isDeleting?: boolean;
  children?: ReactNode;
};

const SCROLLBAR_WHILE_SCROLLING_CLASS =
  "data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100 transition-opacity duration-150";
const PANEL_LAYOUT_TRANSITION_CLASS =
  "transition-[flex-grow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]";

function formatRelativeTime(date: Date, locale: string): string {
  const now = new Date();
  const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  if (diffSeconds < 60) {
    return rtf.format(0, "second");
  }

  const diffMins = Math.floor(diffSeconds / 60);
  if (diffMins < 60) {
    return rtf.format(-diffMins, "minute");
  }

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    return rtf.format(-diffHours, "hour");
  }

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
  folderOptions,
  isLoading,
  isSyncing,
  lastEditDate,
  eventData,
  activeAsset,
  panelLayout,
  onPanelLayoutChange,
  onToggleAsset,
  onTitleChange,
  onDelete,
  onEmojiChange,
  onStarredChange,
  onFolderChange,
  isDeleting = false,
  children,
}: NotePageUIProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const { setIsScrolled, setHeaderContent } = useSettingsHeaderActions();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [, setTick] = useState(0);
  const [localEditTime, setLocalEditTime] = useState<Date | null>(null);
  const panelGroupRef = useRef<ImperativePanelGroupHandle | null>(null);
  const notePaneRef = useRef<HTMLDivElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isSyncing) {
      setLocalEditTime(new Date());
    }
  }, [isSyncing]);

  useEffect(() => {
    if (!panelGroupRef.current) {
      return;
    }

    if (isMobile) {
      panelGroupRef.current.setLayout(activeAsset ? [0, 100] : [100, 0]);
      return;
    }

    if (activeAsset) {
      panelGroupRef.current.setLayout(panelLayout);
    } else {
      panelGroupRef.current.setLayout([100, 0]);
    }
  }, [activeAsset, isMobile, panelLayout]);

  // Detect scroll in the note's own ScrollArea to show/hide the header title
  useEffect(() => {
    const pane = notePaneRef.current;
    const sentinel = scrollSentinelRef.current;
    if (!pane || !sentinel) return;

    const viewport = pane.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsScrolled(!entry.isIntersecting),
      { root: viewport, threshold: 0 },
    );
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
      setIsScrolled(false);
    };
  }, [setIsScrolled, noteTitle]);

  // Stable ref for the starred callback so the header useEffect doesn't loop
  const onStarredChangeRef = useRef(onStarredChange);
  onStarredChangeRef.current = onStarredChange;

  // Set rich header content (emoji + title + star + menu) for the site header
  useEffect(() => {
    setHeaderContent(
      <div className="flex items-center gap-1">
        <span className="flex h-5 w-5 items-center justify-center">
          {noteEmoji ? (
            <span className="text-sm">{noteEmoji}</span>
          ) : (
            <FileTextIcon className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="max-w-[200px] truncate text-sm font-medium">
          {noteTitle || t("settings.notes.note.titlePlaceholder")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => onStarredChangeRef.current(!noteStarred)}
        >
          <Star
            className={`h-3.5 w-3.5 ${
              noteStarred ? "fill-yellow-400 text-yellow-400" : ""
            }`}
          />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
              <MoreHorizontal className="h-3.5 w-3.5" />
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
      </div>,
    );

    return () => setHeaderContent(null);
  }, [noteTitle, noteEmoji, noteStarred, setHeaderContent, t]);

  const handleDeleteClick = () => {
    setShowDeleteDialog(false);
    onDelete();
  };

  const handleEmojiSelect = (emojiData: { emoji: string }) => {
    onEmojiChange(emojiData.emoji);
    setShowEmojiPicker(false);
  };

  const handleToggleStar = () => {
    onStarredChange(!noteStarred);
  };

  const handleCreateFolder = () => {
    setShowCreateFolderDialog(true);
  };

  const handleResizableLayoutChange = (sizes: number[]) => {
    if (sizes.length !== 2) return;
    if (isMobile) return;
    if (sizes[1] <= 0.5) return;
    onPanelLayoutChange([sizes[0], sizes[1]]);
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const displayEditDate =
    localEditTime && localEditTime > lastEditDate ? localEditTime : lastEditDate;
  const isTranscriptionOpen = activeAsset === "transcription";

  const notePane = (
    <div ref={notePaneRef} className="relative h-full min-h-0 bg-background">
      <ScrollArea
        className="h-full"
        type="scroll"
        scrollBarClassName={SCROLLBAR_WHILE_SCROLLING_CLASS}
      >
        <div className="relative mx-auto flex w-full max-w-4xl flex-col gap-2 px-6 pb-32 pt-6">
          <div ref={scrollSentinelRef} className="absolute top-0 h-px w-px" />
          <div className="flex min-w-0 items-center">
            <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-12 w-12 p-0 hover:bg-muted/50"
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
                  {noteEmoji && (
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
                  )}
                  <EmojiPicker
                    onEmojiClick={handleEmojiSelect}
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
              className="flex-1 px-4 py-2 !text-4xl font-semibold !border-0 !shadow-none placeholder:text-muted-foreground focus-visible:!border-0 focus-visible:!ring-0"
              style={{ backgroundColor: "transparent" }}
              placeholder={t("settings.notes.note.titlePlaceholder")}
            />
          </div>

          <div className="flex flex-col gap-0.5 bg-card pl-4">
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-sm text-muted-foreground">
                {t("settings.notes.note.edited", {
                  date: formatRelativeTime(displayEditDate, i18n.language),
                })}
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-2"
                    onClick={handleToggleStar}
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
                  <AlertDialog
                    open={showDeleteDialog}
                    onOpenChange={setShowDeleteDialog}
                  >
                    <AlertDialogTrigger asChild>
                      <DropdownMenuItem
                        className="gap-2"
                        onSelect={(event) => event.preventDefault()}
                        variant="destructive"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                        {t("settings.notes.note.actions.delete")}
                      </DropdownMenuItem>
                    </AlertDialogTrigger>
                  </AlertDialog>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex items-center gap-2">
              {eventData && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Calendar
                    className="h-3.5 w-3.5"
                    style={{ color: eventData.calendarColor }}
                  />
                  <span>{eventData.title}</span>
                  {eventData.startTime && eventData.endTime && (
                    <>
                      <span className="w-1 h-1 bg-muted-foreground rounded-full" />
                      <span className="text-xs">
                        {eventData.startTime} – {eventData.endTime}
                      </span>
                    </>
                  )}
                </div>
              )}

              <Toggle
                pressed={isTranscriptionOpen}
                onPressedChange={() => onToggleAsset("transcription")}
                variant="outline"
                size="sm"
                aria-label={t("settings.notes.note.transcription")}
              >
                {isTranscriptionOpen ? (
                  <PanelRightOpen className="h-3.5 w-3.5" />
                ) : (
                  <PanelRight className="h-3.5 w-3.5" />
                )}
                {t("settings.notes.note.transcription")}
              </Toggle>
            </div>
          </div>

          {children}
        </div>
      </ScrollArea>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10">
        <div className="mx-auto flex w-full max-w-4xl justify-center px-6">
          <div className="pointer-events-auto">
            <NoteRecordingDock />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <TooltipProvider>
      <div className="h-full w-full min-h-0">
        <ResizablePanelGroup
          ref={panelGroupRef}
          direction="horizontal"
          className="h-full w-full"
          onLayout={handleResizableLayoutChange}
        >
          <ResizablePanel
            defaultSize={isMobile ? (activeAsset ? 0 : 100) : activeAsset ? panelLayout[0] : 100}
            minSize={isMobile ? 0 : 45}
            collapsible={isMobile}
            collapsedSize={0}
            className={`min-w-0 ${PANEL_LAYOUT_TRANSITION_CLASS}`}
          >
            {notePane}
          </ResizablePanel>
          <ResizableHandle
            withHandle
            disabled={!isTranscriptionOpen || isMobile}
            className={`z-20 bg-transparent hover:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 [&>div]:transition-opacity [&>div]:duration-150 ${
              isTranscriptionOpen && !isMobile
                ? "[&>div]:opacity-0 hover:[&>div]:opacity-100 focus:[&>div]:opacity-100 active:[&>div]:opacity-100"
                : "pointer-events-none [&>div]:opacity-0"
            }`}
          />
          <ResizablePanel
            defaultSize={isMobile ? (activeAsset ? 100 : 0) : activeAsset ? panelLayout[1] : 0}
            minSize={isMobile ? 0 : 28}
            collapsible
            collapsedSize={0}
            className={`min-w-0 overflow-hidden bg-background ${PANEL_LAYOUT_TRANSITION_CLASS}`}
          >
            <NoteAssetsPanel
              activeAsset="transcription"
              isOpen={isTranscriptionOpen}
              onClose={() => onToggleAsset("transcription")}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

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
    </TooltipProvider>
  );
}
