import { useState, useEffect, useRef, useMemo } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { Loader2, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { NoteSyncProvider } from "@/renderer/main/providers/sync-provider";
import { useSkillDiffDecorations } from "@/renderer/main/components/editor/diff/use-skill-diff-decorations";
import { SkillDiffEditorLock } from "@/renderer/main/components/editor/diff/skill-diff-editor-lock";
import { useSkillDiffStore } from "@/renderer/main/components/editor/diff/skill-diff-store";
import { useSkillDiffToastStore } from "@/renderer/main/components/editor/diff/skill-diff-toast-store";
import { InlineSkillPopoverPlugin } from "@/renderer/main/components/editor/inline-skill-popover/inline-skill-popover-plugin";
import { FindInPagePlugin } from "@/renderer/main/components/editor/find-in-page-plugin";
import { useRegisterNoteEditor } from "@/renderer/main/components/note-editor-context";
import { buildRendererExtensions } from "../utils/editor-shared";

// Keys whose default behaviour mutates the document. Used to gate the
// attention-pulse so navigation / modifier / system keys don't shake
// the dock bar.
function isContentMutatingKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
    case "Escape":
    case "Shift":
    case "CapsLock":
    case "Meta":
    case "Control":
    case "Alt":
      return false;
    default:
      return true;
  }
}

interface NoteEditorProps {
  noteId: number;
  onReady?: () => void;
}

export function NoteEditor({
  noteId,
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
  // any pending debounced writes are flushed while the persistence listener
  // is still attached.
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
    () => [
      ...buildRendererExtensions({
        placeholder,
        ydoc: syncProvider?.getDoc(),
      }),
      SkillDiffEditorLock.configure({ noteId }),
    ],
    [placeholder, noteId, syncProvider],
  );

  // Reset the TipTap editor when the noteId or syncProvider changes — a fresh
  // instance bound to the new provider's Y.Doc avoids stale content flashing in.
  const editor = useEditor(
    {
      extensions,
      editorProps: {
        attributes: {
          class:
            "min-h-[500px] px-4 py-2 outline-none text-base leading-normal text-note-foreground selection:bg-indigo-500/20",
          "aria-placeholder": placeholder,
        },
        // Pulse the dock bar when a user tries to edit under a staged
        // candidate. The lock extension silently blocks the mutation;
        // these handlers exist purely to detect user intent so the
        // attention shake fires for typed/pasted input only and not for
        // system-driven mutations (which the filterTransaction also
        // catches). Read store state via getState() — these handlers fire
        // on user input and must read the latest at event time.
        handleKeyDown(_view, event) {
          const candidate = useSkillDiffStore
            .getState()
            .candidatesByNote.get(noteId);
          // No candidate → editor is live, nothing to nudge. Accept in
          // flight → user has already committed, don't shake at them.
          if (!candidate || candidate.isAccepting) return false;
          if (isContentMutatingKey(event)) {
            useSkillDiffToastStore.getState().pulseAttention();
          }
          return false;
        },
        handlePaste() {
          const candidate = useSkillDiffStore
            .getState()
            .candidatesByNote.get(noteId);
          if (!candidate || candidate.isAccepting) return false;
          useSkillDiffToastStore.getState().pulseAttention();
          return false;
        },
      },
      // Only autofocus on initial mount — re-creating the editor when the
      // user switches notes shouldn't steal focus from wherever they
      // navigated to. The "start" placement matches the original Lexical
      // AutoFocusPlugin behavior.
      autofocus: "start",
      // Initial content is empty — Collaboration syncs the editor view with
      // the provider's Y.Doc (already seeded by syncProvider.loadFromLocal).
      content: undefined,
    },
    [noteId, syncProvider],
  );

  // Publish the editor instance to the layout so the bottom cluster can morph
  // its dock pill into the skill-diff accept bar without owning the editor.
  useRegisterNoteEditor(noteId, editor);

  // Hand the editor back to the provider so the markdown sidecar
  // debouncer can serialize editor.getJSON() when it fires.
  useEffect(() => {
    if (syncProvider && editor) {
      syncProvider.setEditor(editor);
    }
  }, [syncProvider, editor]);

  // Decorate / clear in-document diff when a candidate is staged for this
  // note. The cluster renders the action UI separately; the SkillDiffEditorLock
  // extension above blocks mutations + pulses attention.
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
        <DragHandle editor={editor} className="prismical-drag-handle">
          <GripVertical className="size-3" />
        </DragHandle>
      ) : null}
      {editor ? (
        <InlineSkillPopoverPlugin editor={editor} noteId={noteId} />
      ) : null}
      {editor ? <FindInPagePlugin editor={editor} /> : null}
    </div>
  );
}
