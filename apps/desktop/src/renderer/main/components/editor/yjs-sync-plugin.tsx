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
  // Last value we wrote into yText (or read out of it at seed time).
  // Comparing against this — rather than the freshly-stringified editor
  // state — short-circuits any keystroke that produces JSON byte-identical
  // to what's already stored, even if a future TipTap version introduces
  // a stable-but-different serialization path.
  const lastSyncedJsonRef = useRef<string | null>(null);
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
        lastSyncedJsonRef.current = jsonString;
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
      // Align lastSyncedJsonRef with the editor's POST-seed state, not the
      // raw Y.Text content. Schema-level appendTransactions (e.g. the
      // trailing-paragraph invariant after an artifact) can mutate the
      // doc during setContent — using the raw stored value here would
      // make the next user keystroke see a phantom "diff" and write the
      // normalized form back to Y unnecessarily.
      lastSyncedJsonRef.current = JSON.stringify(editor.getJSON());
    }
    onSyncStatusChangeRef.current?.(false);

    const yjsObserver = () => {
      if (isUpdatingFromEditorRef.current) return;
      const newContent = yText.toString();
      if (!newContent) return;
      if (lastSyncedJsonRef.current === newContent) return;
      setEditorFromJson(newContent);
      lastSyncedJsonRef.current = newContent;
    };
    yText.observe(yjsObserver);

    const onUpdate = ({ editor: ed }: { editor: Editor }) => {
      if (isUpdatingFromYjsRef.current) return;
      const jsonString = JSON.stringify(ed.getJSON());

      // Compare against the last value we synced (in either direction).
      // Comparing against `yText.toString()` would re-trigger writes on
      // any byte-level diff between TipTap's getJSON output and what's
      // stored — even if semantically identical.
      if (jsonString === lastSyncedJsonRef.current) {
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
      // Detach listeners BEFORE flushing, so the synchronous flush write
      // doesn't trigger the yjsObserver re-entrantly (Yjs's observer
      // dispatch can be synchronous within a transact() block).
      yText.unobserve(yjsObserver);
      // useEditor's own cleanup may have destroyed the editor by the time
      // we run (effect ordering between TipTap's hook and ours isn't
      // guaranteed under React strict mode). `off` on a destroyed editor
      // is undefined behavior, so skip it.
      if (!editor.isDestroyed) editor.off("update", onUpdate);
      if (hasPendingRef.current && pendingJsonRef.current) {
        writeJsonToYjs(pendingJsonRef.current);
      }
      debouncedSync.cancel();
    };
  }, [editor, yText, debouncedSync, writeJsonToYjs]);
}
