import * as Y from "yjs";
import { toast } from "sonner";
import type { Editor } from "@tiptap/core";
import { tiptapJsonToMarkdown } from "@/services/notes/tiptap-markdown";

// Window between batched flushes of Yjs updates. Up to ~150ms of typing
// may be unwritten if the renderer crashes mid-window — acceptable per
// spec §4 D6.
const PERSIST_FLUSH_MS = 150;
// Window after the last edit before regenerating the markdown sidecar.
// Search / RAG doesn't need keystroke freshness — spec §4 D7.
const MARKDOWN_DEBOUNCE_MS = 1500;

export interface SyncProviderConfig {
  noteId: number;
  // Optional — the markdown debouncer needs editor.getJSON() to serialize.
  // NoteEditor passes this in via setEditor() once useEditor() has produced
  // an instance. The provider works without it for tests that only care
  // about persistence.
  editor?: Editor;
  onSaveError?: () => void;
}

export class NoteSyncProvider {
  private ydoc: Y.Doc;
  private noteId: number;
  private editor: Editor | undefined;
  private onSaveError: (() => void) | undefined;
  private destroyed = false;

  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private markdownTimer: ReturnType<typeof setTimeout> | null = null;

  private updateHandler: (u: Uint8Array, origin: unknown) => void;

  constructor(config: SyncProviderConfig) {
    this.noteId = config.noteId;
    this.editor = config.editor;
    this.onSaveError = config.onSaveError;
    this.ydoc = new Y.Doc();

    this.updateHandler = (update, origin) => {
      if (this.destroyed) return;
      if (origin === "load") return; // skip our own seed
      this.pendingUpdates.push(update);
      this.scheduleFlush();
      this.scheduleMarkdownFlush();
    };
    this.ydoc.on("update", this.updateHandler);
  }

  getDoc(): Y.Doc {
    return this.ydoc;
  }

  /**
   * @deprecated Shim for Task 7 to remove. `useYjsSync` and its `Y.Text`
   * dependency are being deleted; this method goes with them.
   */
  getText(): Y.Text {
    return this.ydoc.getText("content");
  }

  // Late-binding hook: useEditor() creates the editor AFTER the provider
  // exists (Collaboration needs the provider's Y.Doc up front), so the
  // editor reference flows back in via this setter once available.
  setEditor(editor: Editor): void {
    this.editor = editor;
  }

  async loadFromLocal(): Promise<void> {
    const updates = await window.electronAPI.notes.loadYjsUpdates(this.noteId);
    if (updates.length === 0) return;
    Y.transact(
      this.ydoc,
      () => {
        for (const u of updates) {
          Y.applyUpdate(this.ydoc, new Uint8Array(u), "load");
        }
      },
      "load",
    );
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => void this.flush(), PERSIST_FLUSH_MS);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.destroyed || this.pendingUpdates.length === 0) return;

    const merged = Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];

    try {
      const buf = merged.buffer.slice(
        merged.byteOffset,
        merged.byteOffset + merged.byteLength,
      );
      await window.electronAPI.notes.saveYjsUpdate(
        this.noteId,
        buf as ArrayBuffer,
      );
    } catch (err) {
      if (this.destroyed) return;
      console.error("Failed to save yjs update:", err);
      // Requeue so the next flush retries.
      this.pendingUpdates.unshift(merged);
      this.scheduleFlush();
      (this.onSaveError ?? (() => toast.error("Failed to save changes")))();
    }
  }

  private scheduleMarkdownFlush(): void {
    if (this.markdownTimer) clearTimeout(this.markdownTimer);
    this.markdownTimer = setTimeout(
      () => void this.flushMarkdown(),
      MARKDOWN_DEBOUNCE_MS,
    );
  }

  private async flushMarkdown(): Promise<void> {
    this.markdownTimer = null;
    if (this.destroyed || !this.editor) return;
    try {
      const md = tiptapJsonToMarkdown(this.editor.getJSON());
      await window.electronAPI.notes.setNoteMarkdown(this.noteId, md);
    } catch (err) {
      // Markdown is derived; the next idle window will retry as the user
      // keeps typing. Don't surface to the user.
      console.error("Failed to write markdown sidecar:", err);
    }
  }

  destroy(): void {
    if (this.destroyed) return;

    // Cancel timers so they don't fire on a torn-down provider.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.markdownTimer) {
      clearTimeout(this.markdownTimer);
      this.markdownTimer = null;
    }

    // Flush BEFORE setting destroyed=true — both flush methods short-circuit
    // when destroyed is set, so this ordering is load-bearing.
    if (this.pendingUpdates.length > 0) void this.flush();
    if (this.editor) void this.flushMarkdown();

    this.destroyed = true;
    this.ydoc.off("update", this.updateHandler);
    this.ydoc.destroy();
  }
}
