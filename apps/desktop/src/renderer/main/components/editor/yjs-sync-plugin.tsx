import { useEffect, useRef, useMemo, useCallback } from "react";
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { debounce } from "@/renderer/main/utils/debounce";

interface UseYjsSyncOptions {
  editor: Editor | null;
  yText: Y.Text | null;
  onSyncStatusChange?: (isSyncing: boolean) => void;
}

// Bridges the TipTap editor's JSON state and a Y.Text container that
// persists the note. The Y.Text holds the editor state JSON as a raw
// string — no Yjs-native CRDT binding (per PRSM-50, we're moving to an
// op-log sync adapter; this temporary path keeps the local-only flow
// working until the adapter lands).
export function useYjsSync({
  editor,
  yText,
  onSyncStatusChange,
}: UseYjsSyncOptions): void {
  const isUpdatingFromYjsRef = useRef(false);
  const isUpdatingFromEditorRef = useRef(false);
  const hasPendingRef = useRef(false);
  const pendingJsonRef = useRef<string | null>(null);
  const onSyncStatusChangeRef = useRef(onSyncStatusChange);

  useEffect(() => {
    onSyncStatusChangeRef.current = onSyncStatusChange;
  }, [onSyncStatusChange]);

  const writeJsonToYjs = useCallback(
    (jsonString: string) => {
      if (!yText || isUpdatingFromYjsRef.current) {
        onSyncStatusChangeRef.current?.(false);
        return;
      }

      isUpdatingFromEditorRef.current = true;
      try {
        const yDoc = yText.doc;
        if (yDoc) {
          yDoc.transact(() => {
            const oldLength = yText.length;
            yText.delete(0, oldLength);
            yText.insert(0, jsonString);
          }, "tiptap-sync");
        }
      } finally {
        isUpdatingFromEditorRef.current = false;
        hasPendingRef.current = false;
        pendingJsonRef.current = null;
        onSyncStatusChangeRef.current?.(false);
      }
    },
    [yText],
  );

  const debouncedSync = useMemo(
    () => debounce((jsonString: string) => writeJsonToYjs(jsonString), 500),
    [writeJsonToYjs],
  );

  useEffect(() => {
    if (!editor || !yText) return;

    const setEditorFromJson = (jsonString: string) => {
      try {
        const parsed = JSON.parse(jsonString);
        isUpdatingFromYjsRef.current = true;
        try {
          // emitUpdate=false so the editor.update listener below doesn't
          // turn around and re-write what we just read.
          editor.commands.setContent(parsed, { emitUpdate: false });
        } finally {
          isUpdatingFromYjsRef.current = false;
        }
      } catch (error) {
        console.warn("Failed to parse stored content as TipTap state:", error);
      }
    };

    // Seed the editor from the Yjs container (which carries the persisted
    // state for this note).
    const storedContent = yText.toString();
    if (storedContent) {
      setEditorFromJson(storedContent);
    }
    onSyncStatusChangeRef.current?.(false);

    const yjsObserver = () => {
      if (isUpdatingFromEditorRef.current) return;
      const newContent = yText.toString();
      if (!newContent) return;
      const currentJson = JSON.stringify(editor.getJSON());
      if (currentJson === newContent) return;
      setEditorFromJson(newContent);
    };
    yText.observe(yjsObserver);

    const onUpdate = ({ editor: ed }: { editor: Editor }) => {
      if (isUpdatingFromYjsRef.current) return;
      const jsonString = JSON.stringify(ed.getJSON());
      const currentYjsContent = yText.toString();

      if (jsonString === currentYjsContent) {
        if (hasPendingRef.current) {
          debouncedSync.cancel();
          hasPendingRef.current = false;
          pendingJsonRef.current = null;
          onSyncStatusChangeRef.current?.(false);
        }
        return;
      }

      pendingJsonRef.current = jsonString;
      hasPendingRef.current = true;
      onSyncStatusChangeRef.current?.(true);
      debouncedSync(jsonString);
    };

    editor.on("update", onUpdate);

    return () => {
      if (hasPendingRef.current && pendingJsonRef.current) {
        writeJsonToYjs(pendingJsonRef.current);
      }
      yText.unobserve(yjsObserver);
      editor.off("update", onUpdate);
      debouncedSync.cancel();
    };
  }, [editor, yText, debouncedSync, writeJsonToYjs]);
}
