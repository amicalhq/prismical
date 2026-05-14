import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { AutoLinkPlugin } from "@lexical/react/LexicalAutoLinkPlugin";
import { TRANSFORMERS } from "@lexical/markdown";
import { Loader2 } from "lucide-react";
import { NoteSyncProvider } from "@/renderer/main/providers/sync-provider";
import { YjsSyncPlugin } from "@/renderer/main/components/editor/yjs-sync-plugin";
import { CodeBlockShortcutPlugin } from "@/renderer/main/components/editor/code-block-plugin";
import { ChecklistShortcutPlugin } from "@/renderer/main/components/editor/checklist-shortcut-plugin";
import { ArtifactNodeCommandsPlugin } from "@/renderer/main/components/editor/commands/artifact-commands";
import { SkillDiffActionBar } from "@/renderer/main/components/editor/diff/skill-diff-action-bar";
import { InlineSkillPopoverPlugin } from "@/renderer/main/components/editor/inline-skill-popover/inline-skill-popover-plugin";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  AUTO_LINK_MATCHERS,
  CodeHighlightPlugin,
  EDITOR_NODES,
  editorTheme,
} from "../utils/editor-shared";

interface NoteEditorProps {
  noteId: number;
  onSyncStatusChange?: (isSyncing: boolean) => void;
  onReady?: () => void;
}

function onError(error: Error): void {
  console.error("Lexical error:", error);
}

export function NoteEditor({
  noteId,
  onSyncStatusChange,
  onReady,
}: NoteEditorProps): React.ReactNode {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(true);
  const [syncProvider, setSyncProvider] = useState<NoteSyncProvider | null>(
    null,
  );
  const providerRef = useRef<NoteSyncProvider | null>(null);
  const destroyQueueRef = useRef<Array<NoteSyncProvider>>([]);
  const onReadyCalledRef = useRef(false);
  const onSaveErrorRef = useRef(() =>
    toast.error(t("settings.notes.toast.saveFailed")),
  );

  // Handle sync status changes and propagate to parent
  const handleSyncStatusChange = useCallback(
    (isSyncing: boolean) => {
      onSyncStatusChange?.(isSyncing);
    },
    [onSyncStatusChange],
  );

  // Reset onReady tracking when noteId changes
  useEffect(() => {
    onReadyCalledRef.current = false;
  }, [noteId]);

  useEffect(() => {
    onSaveErrorRef.current = () =>
      toast.error(t("settings.notes.toast.saveFailed"));
  }, [t]);

  // Notify parent when editor is ready
  useEffect(() => {
    if (!isLoading && syncProvider && !onReadyCalledRef.current) {
      onReadyCalledRef.current = true;
      onReady?.();
    }
  }, [isLoading, syncProvider, onReady]);

  // After `syncProvider` changes (either unmounting or swapping to a new
  // provider), it is safe to destroy the previous provider(s). This ensures
  // YjsSyncPlugin can flush any pending debounced writes during its cleanup
  // while the persistence listener is still attached.
  useEffect(() => {
    if (destroyQueueRef.current.length === 0) return;

    const providersToDestroy = destroyQueueRef.current;
    destroyQueueRef.current = [];

    providersToDestroy.forEach((provider) => {
      provider.destroy();
    });
  }, [syncProvider]);

  useEffect(() => {
    let mounted = true;

    const initProvider = async () => {
      // Reset loading state to unmount editor when switching notes
      setIsLoading(true);
      setSyncProvider(null);

      // Queue the previous provider for destruction after unmount. This avoids
      // dropping any pending debounced flushes when switching notes quickly.
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

  // Clean up providers on unmount.
  useEffect(() => {
    return () => {
      if (providerRef.current) {
        providerRef.current.destroy();
        providerRef.current = null;
      }

      destroyQueueRef.current.forEach((provider) => {
        provider.destroy();
      });
      destroyQueueRef.current = [];
    };
  }, []);

  const initialConfig = useMemo(
    () => ({
      namespace: `note-${noteId}`,
      theme: editorTheme,
      onError,
      nodes: EDITOR_NODES,
    }),
    [noteId],
  );

  if (isLoading || !syncProvider) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="min-h-[500px] px-4 py-2 outline-none text-base leading-normal text-note-foreground selection:bg-indigo-500/20"
              aria-placeholder={t("settings.notes.note.bodyPlaceholder")}
              placeholder={
                <div className="absolute top-2 left-4 text-muted-foreground pointer-events-none">
                  {t("settings.notes.note.bodyPlaceholder")}
                </div>
              }
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <AutoFocusPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <TabIndentationPlugin />
        <ClickableLinkPlugin />
        <AutoLinkPlugin matchers={AUTO_LINK_MATCHERS} />
        <CodeHighlightPlugin />
        <CodeBlockShortcutPlugin />
        <ChecklistShortcutPlugin />
        <ArtifactNodeCommandsPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <SkillDiffActionBar noteId={noteId} />
        <InlineSkillPopoverPlugin noteId={noteId} />
        <YjsSyncPlugin
          yText={syncProvider.getText()}
          onSyncStatusChange={handleSyncStatusChange}
        />
      </div>
    </LexicalComposer>
  );
}
