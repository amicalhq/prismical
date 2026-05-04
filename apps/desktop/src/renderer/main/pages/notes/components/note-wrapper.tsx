import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { debounce } from "@/renderer/main/utils/debounce";
import {
  TRANSCRIPTION_OPEN_EVENT,
  consumeOpenTranscriptionRequest,
} from "@/renderer/main/utils/transcription-request";
import Note from "./note";
import { NoteEditor } from "./note-editor";
import { ArtifactEditor } from "./artifact-editor";
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
import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import {
  useRegisterCurrentNote,
  type CurrentNoteContextValue,
} from "@/renderer/main/components/current-note-context";
import { useMeetingSnapshot } from "@/renderer/main/components/meeting-snapshot-context";
import type { NoteAssetKind } from "../types";
import type { NoteTab } from "./note";
import type { MeetingRuntimeState, TranscriptEvent } from "@/types/meeting";

type NotePageProps = {
  noteId: string;
  onBack?: () => void;
  autoRecord?: boolean;
  openTranscription?: boolean;
};

export default function NotePage({
  noteId,
  onBack,
  autoRecord,
  openTranscription,
}: NotePageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const startMeetingMutation = api.meetings.startMeeting.useMutation();
  const stopMeetingMutation = api.meetings.stopMeeting.useMutation();
  const generateNotesMutation =
    api.notes.generateNotesFromTranscript.useMutation();
  const noteIdNumber = Number.parseInt(noteId, 10);
  const defaultsQuery = api.instances.getDefaults.useQuery();
  const hasFormattingDefault = !!defaultsQuery.data?.formatting;
  const noteTranscriptQuery = api.meetings.getNoteTranscript.useQuery(
    { noteId: noteIdNumber },
    {
      enabled: Number.isFinite(noteIdNumber) && noteIdNumber > 0,
    },
  );

  // State
  const [noteTitle, setNoteTitle] = useState("");
  const [noteIcon, setNoteIcon] = useState<string | null>(null);
  const [noteStarred, setNoteStarred] = useState(false);
  const [noteFolder, setNoteFolder] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [activeAsset, setActiveAsset] = useState<NoteAssetKind | null>(null);
  const [meetingState, setMeetingState] = useState<MeetingRuntimeState>("idle");
  const [transcript, setTranscript] = useState<TranscriptEvent[]>([]);
  const [isTranscriptionExpanded, setIsTranscriptionExpanded] = useState(false);

  const noteRef = useRef<typeof note>(null);
  const autoRecordTriggeredRef = useRef(false);

  // Active artifact (latest "summary" for this note). Drives tab visibility
  // and the AI Summary tab's content.
  const artifactQuery = api.artifacts.getByNote.useQuery(
    { noteId: noteIdNumber, kind: "summary" },
    { enabled: Number.isFinite(noteIdNumber) && noteIdNumber > 0 },
  );
  const artifact = artifactQuery.data ?? null;

  // Active tab. Defaults to AI Summary when an artifact exists, otherwise Raw.
  const [activeTab, setActiveTab] = useState<NoteTab>("summary");
  const lastSeenArtifactUpdatedAtRef = useRef<number | null>(null);

  // Surfaced when the user clicks "Generate notes" without a default language
  // model configured — dialog routes them to the settings page.
  const [showNoLanguageModelDialog, setShowNoLanguageModelDialog] =
    useState(false);

  // Auto-switch to AI Summary when a new/updated artifact arrives.
  useEffect(() => {
    if (!artifact) {
      lastSeenArtifactUpdatedAtRef.current = null;
      return;
    }
    const updatedAtMs = artifact.updatedAt.getTime();
    if (lastSeenArtifactUpdatedAtRef.current === null) {
      lastSeenArtifactUpdatedAtRef.current = updatedAtMs;
      setActiveTab("summary");
      return;
    }
    if (updatedAtMs > lastSeenArtifactUpdatedAtRef.current) {
      lastSeenArtifactUpdatedAtRef.current = updatedAtMs;
      setActiveTab("summary");
    }
  }, [artifact]);

  // Fetch note data
  const { data: note, isLoading } = api.notes.getNoteById.useQuery(
    { id: noteIdNumber },
    {
      enabled: !!noteId,
    },
  );

  const { data: allNotes = [] } = api.notes.getNotes.useQuery({
    limit: 500,
    sortBy: "updatedAt",
    sortOrder: "desc",
  });

  const updateTitleMutation = api.notes.updateNoteTitle.useMutation({
    onSuccess: () => {
      utils.notes.getNotes.invalidate();
      utils.notes.getNoteById.invalidate({ id: noteIdNumber });
    },
  });

  const updateNoteIconMutation = api.notes.updateNoteIcon.useMutation({
    onSuccess: () => {
      utils.notes.getNotes.invalidate();
      utils.notes.getNoteById.invalidate({ id: noteIdNumber });
      toast.success(t("settings.notes.toast.emojiUpdated"));
    },
    onError: (error) => {
      toast.error(
        t("settings.notes.toast.emojiUpdateFailed", { message: error.message }),
      );
    },
  });

  const updateNoteOrganizationMutation =
    api.notes.updateNoteOrganization.useMutation({
      onSuccess: () => {
        utils.notes.getNotes.invalidate();
        utils.notes.getNoteById.invalidate({ id: noteIdNumber });
      },
      onError: (error) => {
        toast.error(
          t("settings.notes.toast.organizationUpdateFailed", {
            message: error.message,
          }),
        );
      },
    });

  // Delete mutation
  const deleteMutation = api.notes.deleteNote.useMutation({
    onSuccess: () => {
      utils.notes.getNotes.invalidate();
      // Use onBack if provided, otherwise navigate
      if (onBack) {
        onBack();
      } else {
        navigate({ to: "/settings/notes" });
      }
      toast.success(t("settings.notes.toast.deleted"));
    },
    onError: (error) => {
      toast.error(
        t("settings.notes.toast.deleteFailed", { message: error.message }),
      );
    },
  });

  const debouncedUpdateTitle = useMemo(
    () =>
      debounce((title: string) => {
        const currentNote = noteRef.current;
        if (currentNote && title !== currentNote.title) {
          updateTitleMutation.mutate({ id: currentNote.id, title });
        }
      }, 500),
    [updateTitleMutation],
  );

  // Update note-derived state
  useEffect(() => {
    noteRef.current = note;
    if (note) {
      setNoteTitle(note.title);
      setNoteIcon(note.icon || null);
      setNoteStarred(note.starred ?? false);
      setNoteFolder(note.folder ?? null);
    }
  }, [note]);

  // Reset state when noteId changes
  useEffect(() => {
    setEditorReady(false);
    autoRecordTriggeredRef.current = false;
    setMeetingState("idle");
    setTranscript([]);
  }, [noteId]);

  useEffect(() => {
    if (noteTranscriptQuery.data) {
      setTranscript(noteTranscriptQuery.data);
    }
  }, [noteTranscriptQuery.data]);

  const refreshNoteTranscript = useCallback(async () => {
    if (!Number.isFinite(noteIdNumber) || noteIdNumber <= 0) {
      setTranscript([]);
      return [];
    }

    const aggregatedTranscript = await utils.meetings.getNoteTranscript.fetch({
      noteId: noteIdNumber,
    });
    setTranscript(aggregatedTranscript);
    return aggregatedTranscript;
  }, [noteIdNumber, utils.meetings.getNoteTranscript]);

  const debouncedRefreshNoteTranscript = useMemo(
    () =>
      debounce(() => {
        void refreshNoteTranscript();
      }, 100),
    [refreshNoteTranscript],
  );

  useEffect(
    () => () => {
      debouncedRefreshNoteTranscript.cancel();
    },
    [debouncedRefreshNoteTranscript],
  );

  const meetingSnapshot = useMeetingSnapshot();

  // Derive per-note meeting state from the shared snapshot. The snapshot is
  // global; we coerce to "idle" when the active session belongs to a different
  // note so that per-note dock UI / transcript panel render correctly.
  useEffect(() => {
    const isCurrentNoteSession = meetingSnapshot.noteId === noteIdNumber;
    setMeetingState(isCurrentNoteSession ? meetingSnapshot.state : "idle");
    if (isCurrentNoteSession && meetingSnapshot.state !== "idle") {
      setActiveAsset("transcription");
    }
  }, [meetingSnapshot.noteId, meetingSnapshot.state, noteIdNumber]);

  api.meetings.transcriptUpdates.useSubscription(undefined, {
    onData: (event) => {
      if (event.noteId === noteIdNumber) {
        debouncedRefreshNoteTranscript();
      }
    },
    onError: (error) => {
      console.error("Failed to subscribe to meeting transcript:", error);
    },
  });

  // Handle editor ready
  const handleEditorReady = useCallback(() => {
    setEditorReady(true);
  }, []);

  // Cold-start path: when the user opens the note from a closed main window,
  // the floating widget passes `?openTranscription=true` in the URL hash so
  // we know to force the panel open on first mount. Ref-guarded so it fires
  // once per mount without re-running on every re-render.
  const transcriptionForcedRef = useRef(false);
  useEffect(() => {
    if (!openTranscription || transcriptionForcedRef.current) return;
    transcriptionForcedRef.current = true;
    setActiveAsset("transcription");
  }, [openTranscription]);

  // Cross-note widget click path: the widget navigated us here and queued
  // a request before this wrapper mounted, so drain the pending set on
  // mount / when noteId changes.
  useEffect(() => {
    if (consumeOpenTranscriptionRequest(noteIdNumber)) {
      setActiveAsset("transcription");
    }
  }, [noteIdNumber]);

  // Same-note widget click path: the widget asked an already-mounted page
  // to open its panel — handled via DOM event so it can re-trigger after
  // the user manually closes the panel.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId: number }>).detail;
      if (detail?.noteId === noteIdNumber) {
        setActiveAsset("transcription");
      }
    };
    window.addEventListener(TRANSCRIPTION_OPEN_EVENT, handler);
    return () => {
      window.removeEventListener(TRANSCRIPTION_OPEN_EVENT, handler);
    };
  }, [noteIdNumber]);

  // Auto-start recording when editor is ready and autoRecord flag is set
  useEffect(() => {
    if (editorReady && autoRecord && !autoRecordTriggeredRef.current) {
      autoRecordTriggeredRef.current = true;
      startMeetingMutation
        .mutateAsync({ noteId: noteIdNumber, mode: "dual" })
        .then(() => {
          setActiveAsset("transcription");
        })
        .catch((error) => {
          console.error("Failed to auto-start meeting capture:", error);
        });
    }
  }, [autoRecord, editorReady, noteIdNumber, startMeetingMutation]);

  const handleStartMeeting = useCallback(() => {
    if (meetingState !== "idle") {
      return;
    }

    startMeetingMutation
      .mutateAsync({ noteId: noteIdNumber, mode: "dual" })
      .then(() => {
        setActiveAsset("transcription");
      })
      .catch((error) => {
        toast.error(`Failed to start meeting transcription: ${error.message}`);
      });
  }, [meetingState, noteIdNumber, startMeetingMutation]);

  const handleStopMeeting = useCallback(() => {
    if (meetingState !== "recording" && meetingState !== "error") {
      return;
    }

    stopMeetingMutation
      .mutateAsync()
      .then(async () => {
        setActiveAsset("transcription");
        await refreshNoteTranscript();
      })
      .catch((error) => {
        toast.error(`Failed to stop meeting transcription: ${error.message}`);
      });
  }, [meetingState, refreshNoteTranscript, stopMeetingMutation]);

  const handleGenerateNotes = useCallback(() => {
    if (!hasFormattingDefault) {
      setShowNoLanguageModelDialog(true);
      return;
    }

    generateNotesMutation
      .mutateAsync({ noteId: noteIdNumber })
      .then(() => {
        utils.artifacts.getByNote.invalidate({
          noteId: noteIdNumber,
          kind: "summary",
        });
        toast.success("AI Summary generated.");
      })
      .catch((error) => {
        toast.error(`Failed to generate notes: ${error.message}`);
      });
  }, [
    hasFormattingDefault,
    generateNotesMutation,
    noteIdNumber,
    utils.artifacts.getByNote,
  ]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setNoteTitle(newTitle);
      debouncedUpdateTitle(newTitle);
    },
    [debouncedUpdateTitle],
  );

  // Handle delete
  const handleDelete = useCallback(() => {
    deleteMutation.mutate({ id: noteIdNumber });
  }, [noteIdNumber, deleteMutation]);

  const handleStarredChange = useCallback(
    (starred: boolean) => {
      setNoteStarred(starred);
      updateNoteOrganizationMutation.mutate({
        id: noteIdNumber,
        starred,
      });
    },
    [noteIdNumber, updateNoteOrganizationMutation],
  );

  const handleFolderChange = useCallback(
    (folder: string | null) => {
      setNoteFolder(folder);
      updateNoteOrganizationMutation.mutate({
        id: noteIdNumber,
        folder,
      });
    },
    [noteIdNumber, updateNoteOrganizationMutation],
  );

  const folderOptions = useMemo(() => {
    const names = allNotes
      .map((entry) => entry.folder?.trim())
      .filter((name): name is string => Boolean(name));
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  }, [allNotes]);

  const handleToggleAsset = useCallback((asset: NoteAssetKind) => {
    setActiveAsset((currentAsset) => (currentAsset === asset ? null : asset));
  }, []);

  const handleToggleTranscription = useCallback(() => {
    handleToggleAsset("transcription");
  }, [handleToggleAsset]);

  const isTranscriptionOpen = activeAsset === "transcription";

  const currentNoteValue = useMemo<CurrentNoteContextValue | null>(() => {
    if (!Number.isFinite(noteIdNumber) || noteIdNumber <= 0) {
      return null;
    }
    // Wait until the note has actually loaded — otherwise we'd register a
    // value pointing at a not-yet-loaded (or deleted) note, surfacing
    // unusable handlers to the cluster.
    if (!note) {
      return null;
    }
    return {
      noteId: noteIdNumber,
      title: noteTitle,
      transcript,
      isTranscriptionOpen,
      isTranscriptionExpanded,
      onToggleTranscription: handleToggleTranscription,
      onSetTranscriptionExpanded: setIsTranscriptionExpanded,
      meetingState,
      onStartMeeting: handleStartMeeting,
      onStopMeeting: handleStopMeeting,
      hasArtifact: Boolean(artifact),
      activeTab,
      onActiveTabChange: setActiveTab,
      onGenerateNotes: handleGenerateNotes,
      isGeneratingNotes: generateNotesMutation.isPending,
    };
  }, [
    noteIdNumber,
    note,
    noteTitle,
    transcript,
    isTranscriptionOpen,
    isTranscriptionExpanded,
    handleToggleTranscription,
    meetingState,
    handleStartMeeting,
    handleStopMeeting,
    artifact,
    activeTab,
    handleGenerateNotes,
    generateNotesMutation.isPending,
  ]);

  const handleEmojiChange = useCallback(
    (emoji: string | null) => {
      setNoteIcon(emoji);
      updateNoteIconMutation.mutate({ id: noteIdNumber, icon: emoji });
    },
    [noteIdNumber, updateNoteIconMutation],
  );

  // Push the per-note value into the layout-level CurrentNoteContext so the
  // global RecordingBottomCluster (mounted as a sibling of <Outlet />) can
  // read it. The setter is keyed by noteId so an A→B navigation (where B's
  // mount runs before A's unmount cleanup) doesn't leave the slot null.
  const registerCurrentNote = useRegisterCurrentNote();
  useEffect(() => {
    if (!Number.isFinite(noteIdNumber) || noteIdNumber <= 0) {
      return;
    }
    registerCurrentNote(noteIdNumber, currentNoteValue);
    return () => {
      registerCurrentNote(noteIdNumber, null);
    };
  }, [noteIdNumber, currentNoteValue, registerCurrentNote]);

  // Note not found state
  if (!isLoading && !note) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <FileTextIcon className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">{t("settings.notes.notFound")}</p>
        <Button
          variant="outline"
          onClick={() => {
            if (onBack) {
              onBack();
            } else {
              navigate({ to: "/settings/notes" });
            }
          }}
        >
          {t("settings.notes.backToNotes")}
        </Button>
      </div>
    );
  }
  // Use the presentational component
  return (
    <>
      <Note
        noteTitle={noteTitle}
        noteEmoji={noteIcon}
        noteStarred={noteStarred}
        noteFolder={noteFolder}
        folderOptions={folderOptions}
        isLoading={isLoading}
        onTitleChange={handleTitleChange}
        onDelete={handleDelete}
        onEmojiChange={handleEmojiChange}
        onStarredChange={handleStarredChange}
        onFolderChange={handleFolderChange}
        noteUpdatedAt={note?.updatedAt ?? new Date()}
        eventData={note?.eventData ?? null}
        isDeleting={deleteMutation.isPending}
      >
        {(() => {
          // Drives the same-hue text shimmer (see .ai-generating-text in
          // globals.css). Wrappers below opt in while regeneration is in flight.
          const shimmerClass = generateNotesMutation.isPending
            ? "ai-generating-text"
            : "";
          return artifact ? (
            // Both editors stay mounted so switching tabs doesn't tear down the
            // Yjs editor (slow to re-init) or discard in-flight artifact edits.
            // The inactive one is hidden via CSS.
            <>
              <div
                className={`${activeTab === "summary" ? "block" : "hidden"} ${shimmerClass}`}
              >
                <ArtifactEditor
                  // Remount on regeneration so Lexical re-seeds from the new
                  // content. `generatedAt` advances on regen but not on user
                  // edits (updateArtifactContent only touches updated_at), so
                  // typing won't blow away the editor.
                  key={`${artifact.id}:${artifact.generatedAt?.getTime() ?? 0}`}
                  artifactId={artifact.id}
                  initialContent={artifact.content}
                />
              </div>
              <div
                className={`${activeTab === "raw" ? "block" : "hidden"} ${shimmerClass}`}
              >
                <NoteEditor noteId={noteIdNumber} onReady={handleEditorReady} />
              </div>
            </>
          ) : (
            <div className={shimmerClass}>
              <NoteEditor noteId={noteIdNumber} onReady={handleEditorReady} />
            </div>
          );
        })()}
      </Note>
      <AlertDialog
        open={showNoLanguageModelDialog}
        onOpenChange={setShowNoLanguageModelDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Set a default language model</AlertDialogTitle>
            <AlertDialogDescription>
              Generating an AI summary needs a language model. Pick one in
              Settings → AI Models and try again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowNoLanguageModelDialog(false);
                navigate({
                  to: "/settings/ai-models",
                  search: { tab: "language" },
                });
              }}
            >
              Open settings
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
