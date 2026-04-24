import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { debounce } from "@/renderer/main/utils/debounce";
import Note from "./note";
import { NoteEditor } from "./note-editor";
import { ArtifactEditor } from "./artifact-editor";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { NoteAssetKind } from "../types";

type NoteTab = "summary" | "raw";
import type {
  MeetingRuntimeSnapshot,
  MeetingRuntimeState,
  TranscriptEvent,
} from "@/types/meeting";

type NotePageProps = {
  noteId: string;
  onBack?: () => void;
  autoRecord?: boolean;
};

export default function NotePage({
  noteId,
  onBack,
  autoRecord,
}: NotePageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const startMeetingMutation = api.meetings.startMeeting.useMutation();
  const stopMeetingMutation = api.meetings.stopMeeting.useMutation();
  const generateNotesMutation =
    api.notes.generateNotesFromTranscript.useMutation();
  const noteIdNumber = Number.parseInt(noteId, 10);
  const defaultLanguageModelQuery = api.models.getDefaultModel.useQuery({
    type: "language",
  });
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

  api.meetings.stateUpdates.useSubscription(undefined, {
    onData: (snapshot: MeetingRuntimeSnapshot) => {
      const isCurrentNoteSession = snapshot.noteId === noteIdNumber;
      setMeetingState(isCurrentNoteSession ? snapshot.state : "idle");

      if (isCurrentNoteSession && snapshot.state !== "idle") {
        setActiveAsset("transcription");
      }
    },
    onError: (error) => {
      console.error("Failed to subscribe to meeting state:", error);
    },
  });

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
    if (!defaultLanguageModelQuery.data) {
      toast.error("Configure a language model before generating notes.");
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
    defaultLanguageModelQuery.data,
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

  const handleEmojiChange = useCallback(
    (emoji: string | null) => {
      setNoteIcon(emoji);
      updateNoteIconMutation.mutate({ id: noteIdNumber, icon: emoji });
    },
    [noteIdNumber, updateNoteIconMutation],
  );

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
    <Note
      noteId={noteIdNumber}
      noteTitle={noteTitle}
      noteEmoji={noteIcon}
      noteStarred={noteStarred}
      noteFolder={noteFolder}
      folderOptions={folderOptions}
      isLoading={isLoading}
      activeAsset={activeAsset}
      onToggleAsset={handleToggleAsset}
      onTitleChange={handleTitleChange}
      onDelete={handleDelete}
      onEmojiChange={handleEmojiChange}
      onStarredChange={handleStarredChange}
      onFolderChange={handleFolderChange}
      meetingState={meetingState}
      transcript={transcript}
      onStartMeeting={handleStartMeeting}
      onStopMeeting={handleStopMeeting}
      onGenerateNotes={handleGenerateNotes}
      canGenerateNotes={Boolean(defaultLanguageModelQuery.data)}
      isGeneratingNotes={generateNotesMutation.isPending}
      isDeleting={deleteMutation.isPending}
    >
      {artifact ? (
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as NoteTab)}
          className="w-full"
        >
          <TabsList>
            <TabsTrigger value="summary">AI Summary</TabsTrigger>
            <TabsTrigger value="raw">Raw notes</TabsTrigger>
          </TabsList>
          {/* forceMount keeps both editors alive so switching tabs doesn't
              tear down/re-init the Yjs editor (slow) or discard in-flight
              artifact edits. Inactive tab content is hidden via CSS. */}
          <TabsContent value="summary" forceMount className="hidden data-[state=active]:block">
            <ArtifactEditor
              artifactId={artifact.id}
              initialContent={artifact.content}
            />
          </TabsContent>
          <TabsContent value="raw" forceMount className="hidden data-[state=active]:block">
            <NoteEditor noteId={noteIdNumber} onReady={handleEditorReady} />
          </TabsContent>
        </Tabs>
      ) : (
        <NoteEditor noteId={noteIdNumber} onReady={handleEditorReady} />
      )}
    </Note>
  );
}
