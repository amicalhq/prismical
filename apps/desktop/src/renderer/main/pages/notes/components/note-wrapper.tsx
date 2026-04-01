import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import Note from "./note";
import { NoteEditor } from "./note-editor";
import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { NoteAssetKind } from "../types";

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
  const startRecordingMutation = api.recording.signalStart.useMutation();
  const noteIdNumber = Number.parseInt(noteId, 10);

  // State
  const [noteTitle, setNoteTitle] = useState("");
  const [noteStarred, setNoteStarred] = useState(false);
  const [noteFolder, setNoteFolder] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const [activeAsset, setActiveAsset] = useState<NoteAssetKind | null>(null);

  const autoRecordTriggeredRef = useRef(false);

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

  // Update note-derived state
  useEffect(() => {
    if (note) {
      setNoteTitle(note.title);
      setNoteStarred(note.starred ?? false);
      setNoteFolder(note.folder ?? null);
    }
  }, [note]);

  // Reset state when noteId changes
  useEffect(() => {
    setEditorReady(false);
    autoRecordTriggeredRef.current = false;
  }, [noteId]);

  // Handle editor ready
  const handleEditorReady = useCallback(() => {
    setEditorReady(true);
  }, []);

  // Auto-start recording when editor is ready and autoRecord flag is set
  useEffect(() => {
    if (editorReady && autoRecord && !autoRecordTriggeredRef.current) {
      autoRecordTriggeredRef.current = true;
      startRecordingMutation.mutateAsync().catch((error) => {
        console.error("Failed to auto-start recording:", error);
      });
    }
  }, [editorReady, autoRecord, startRecordingMutation]);

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
      noteStarred={noteStarred}
      noteFolder={noteFolder}
      folderOptions={folderOptions}
      isLoading={isLoading}
      activeAsset={activeAsset}
      onToggleAsset={handleToggleAsset}
      onDelete={handleDelete}
      onStarredChange={handleStarredChange}
      onFolderChange={handleFolderChange}
      isDeleting={deleteMutation.isPending}
    >
      <NoteEditor noteId={noteIdNumber} onReady={handleEditorReady} />
    </Note>
  );
}
