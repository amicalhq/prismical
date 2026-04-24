import { useCallback, useEffect, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { AutoLinkPlugin } from "@lexical/react/LexicalAutoLinkPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { TRANSFORMERS } from "@lexical/markdown";
import type { EditorState } from "lexical";
import { useTranslation } from "react-i18next";
import {
  AUTO_LINK_MATCHERS,
  CodeHighlightPlugin,
  EDITOR_NODES,
  editorTheme,
} from "../utils/editor-shared";
import { CodeBlockShortcutPlugin } from "@/renderer/main/components/editor/code-block-plugin";
import { ChecklistShortcutPlugin } from "@/renderer/main/components/editor/checklist-shortcut-plugin";
import { api } from "@/trpc/react";
import { debounce } from "@/renderer/main/utils/debounce";

interface ArtifactEditorProps {
  artifactId: string;
  // Lexical editor-state JSON string. Used to seed the editor once per
  // artifactId — edits flow forward via the debounced save mutation, not
  // back through this prop.
  initialContent: string;
}

function onError(error: Error): void {
  console.error("Lexical error (artifact):", error);
}

export function ArtifactEditor({
  artifactId,
  initialContent,
}: ArtifactEditorProps): React.ReactNode {
  const { t } = useTranslation();
  // `mutate` from react-query is a stable reference across re-renders; the
  // wrapping mutation-result object is not. Depending on `mutate` keeps the
  // debounce instance stable so concurrent typing doesn't spawn orphan timers.
  const { mutate: updateContentMutate } =
    api.artifacts.updateContent.useMutation();
  // Track the latest artifactId on a ref so debounced saves always target the
  // currently-displayed artifact even if props change mid-flight.
  const artifactIdRef = useRef(artifactId);
  useEffect(() => {
    artifactIdRef.current = artifactId;
  }, [artifactId]);

  // Debounce saves by 500ms to avoid hammering the DB on every keystroke.
  const debouncedSave = useMemo(
    () =>
      debounce((serialized: string) => {
        updateContentMutate({
          artifactId: artifactIdRef.current,
          content: serialized,
        });
      }, 500),
    [updateContentMutate],
  );

  useEffect(() => () => debouncedSave.cancel(), [debouncedSave]);

  const handleChange = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const serialized = JSON.stringify(editorState.toJSON());
        debouncedSave(serialized);
      });
    },
    [debouncedSave],
  );

  const initialConfig = useMemo(
    () => ({
      namespace: `artifact-${artifactId}`,
      theme: editorTheme,
      onError,
      nodes: EDITOR_NODES,
      editorState: initialContent,
    }),
    // Deliberately re-create the config (and thus the editor) when switching
    // to a different artifact — initialContent only seeds on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifactId],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="min-h-[500px] px-4 py-2 outline-none text-base leading-relaxed"
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
        <ListPlugin />
        <CheckListPlugin />
        <TabIndentationPlugin />
        <ClickableLinkPlugin />
        <AutoLinkPlugin matchers={AUTO_LINK_MATCHERS} />
        <CodeHighlightPlugin />
        <CodeBlockShortcutPlugin />
        <ChecklistShortcutPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange />
      </div>
    </LexicalComposer>
  );
}
