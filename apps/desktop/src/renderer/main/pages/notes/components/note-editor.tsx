import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { NoteSyncProvider } from "@/renderer/main/providers/sync-provider";
import { useYjsSync } from "@/renderer/main/components/editor/yjs-sync-plugin";
import { useSkillDiffDecorations } from "@/renderer/main/components/editor/diff/use-skill-diff-decorations";
import { InlineSkillPopoverPlugin } from "@/renderer/main/components/editor/inline-skill-popover/inline-skill-popover-plugin";
import { useRegisterNoteEditor } from "@/renderer/main/components/note-editor-context";
import { buildRendererExtensions } from "../utils/editor-shared";

interface NoteEditorProps {
  noteId: number;
  onSyncStatusChange?: (isSyncing: boolean) => void;
  onReady?: () => void;
}

export function NoteEditor({
  noteId,
  onSyncStatusChange,
  onReady,
}: NoteEditorProps): React.ReactNode {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [syncProvider, setSyncProvider] = useState<NoteSyncProvider | null>(null);
  const providerRef = useRef<NoteSyncProvider | null>(null);
  const destroyQueueRef = useRef<Array<NoteSyncProvider>>([]);
  const onReadyCalledRef = useRef(false);
  const onSaveErrorRef = useRef(() =>
    toast.error(t("settings.notes.toast.saveFailed")),
  );

  const handleSyncStatusChange = useCallback(
    (isSyncing: boolean) => {
      onSyncStatusChange?.(isSyncing);
    },
    [onSyncStatusChange],
  );

  // Reset onReady tracking when noteId changes.
  useEffect(() => {
    onReadyCalledRef.current = false;
  }, [noteId]);

  useEffect(() => {
    onSaveErrorRef.current = () =>
      toast.error(t("settings.notes.toast.saveFailed"));
  }, [t]);

  // After `syncProvider` changes (either unmounting or swapping to a new
  // provider), it is safe to destroy the previous provider(s). This ensures
  // useYjsSync can flush any pending debounced writes during its cleanup
  // while the persistence listener is still attached.
  useEffect(() => {
    if (destroyQueueRef.current.length === 0) return;
    const providersToDestroy = destroyQueueRef.current;
    destroyQueueRef.current = [];
    providersToDestroy.forEach((provider) => provider.destroy());
  }, [syncProvider]);

  useEffect(() => {
    let mounted = true;

    const initProvider = async () => {
      setIsLoading(true);
      setSyncProvider(null);

      if (providerRef.current) {
        destroyQueueRef.current.push(providerRef.current);
        providerRef.current = null;
      }

      const provider = new NoteSyncProvider({
        noteId,
        onSaveError: () => onSaveErrorRef.current(),
      });

      providerRef.current = provider;

      try {
        await provider.loadFromLocal();
      } catch (error) {
        console.error("Failed to load note content:", error);
      }

      if (mounted) {
        setSyncProvider(provider);
        setIsLoading(false);
      }
    };

    initProvider();

    return () => {
      mounted = false;
    };
  }, [noteId]);

  // Final cleanup on unmount.
  useEffect(() => {
    return () => {
      if (providerRef.current) {
        providerRef.current.destroy();
        providerRef.current = null;
      }
      destroyQueueRef.current.forEach((provider) => provider.destroy());
      destroyQueueRef.current = [];
    };
  }, []);

  const placeholder = t("settings.notes.note.bodyPlaceholder");

  const extensions = useMemo(
    () => buildRendererExtensions({ placeholder }),
    [placeholder],
  );

  // Reset the TipTap editor when the noteId or syncProvider changes — a fresh
  // instance with the new initial seed avoids stale content flashing in.
  // useYjsSync's cleanup flushes any pending debounced write to the OLD
  // syncProvider before this hook's teardown destroys the view, so we don't
  // lose keystrokes across note switches.
  const editor = useEditor(
    {
      extensions,
      editorProps: {
        attributes: {
          class:
            "min-h-[500px] px-4 py-2 outline-none text-base leading-normal text-note-foreground selection:bg-indigo-500/20",
          "aria-placeholder": placeholder,
        },
      },
      // Only autofocus on initial mount — re-creating the editor when the
      // user switches notes shouldn't steal focus from wherever they
      // navigated to. The "start" placement matches the original Lexical
      // AutoFocusPlugin behavior.
      autofocus: "start",
      // Initial content is empty — useYjsSync seeds the doc from the Y.Text
      // container once the sync provider has loaded the persisted state.
      content: undefined,
    },
    [noteId, syncProvider],
  );

  useYjsSync({
    editor,
    yText: syncProvider?.getText() ?? null,
    onSyncStatusChange: handleSyncStatusChange,
  });

  // Publish the editor instance to the layout so the bottom cluster can morph
  // its dock pill into the skill-diff accept bar without owning the editor.
  useRegisterNoteEditor(noteId, editor);

  // Decorate / clear in-document diff when a candidate is staged for this
  // note. The cluster renders the action UI separately.
  useSkillDiffDecorations(editor, noteId);

  // Notify parent when editor is ready (after the provider is hooked up and
  // the editor exists).
  useEffect(() => {
    if (!isLoading && syncProvider && editor && !onReadyCalledRef.current) {
      onReadyCalledRef.current = true;
      onReady?.();
    }
  }, [isLoading, syncProvider, editor, onReady]);

  if (isLoading || !syncProvider) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="relative">
      <EditorContent editor={editor} />
      {editor ? (
        <InlineSkillPopoverPlugin editor={editor} noteId={noteId} />
      ) : null}
    </div>
  );
}
