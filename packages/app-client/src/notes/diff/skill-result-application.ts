import { Editor } from "@tiptap/core";
import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { waitForNoteDelivery } from "../note-delivery";
import { buildWebEditorExtensions } from "../editor-extensions";

function documentOf(editor: Editor): Y.Doc | undefined {
  return editor.extensionManager.extensions.find(e => e.name === "collaboration")?.options.document;
}

/** The receipt travels with the body update and survives reopening and later edits. */
export function wasSkillResultApplied(editor: Editor, resultId: string): boolean {
  return documentOf(editor)?.getMap("appliedSkillResults").has(resultId) ?? false;
}

/** Prepare without touching the live document. The server chooses one update for every retry. */
export function prepareSkillResultUpdate(editor: Editor, resultId: string, apply: (draft: Editor) => boolean): string {
  const source = documentOf(editor);
  if (!source) throw new Error("The collaborative document is unavailable.");
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  const draft = new Editor({ extensions: buildWebEditorExtensions(clone, "", "") });
  try {
    clone.transact(() => {
      if (!apply(draft)) throw new Error("The suggestion could not be applied.");
      clone.getMap("appliedSkillResults").set(resultId, true);
    }, ySyncPluginKey);
    const bytes = Y.encodeStateAsUpdate(clone);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    if (encoded.length > 900_000) throw new Error("The suggestion exceeds the saved update limit.");
    return encoded;
  } finally {
    draft.destroy();
    clone.destroy();
  }
}

/** Applying the exact same CRDT update is idempotent, including across concurrent clients. */
export function applyPreparedSkillResult(editor: Editor, update: string, historyEditor?: Editor | null): void {
  const doc = documentOf(editor);
  if (!doc) throw new Error("The collaborative document is unavailable.");
  // The dock owns a private editor. Apply to the live note first so this local action
  // enters its history before provider delivery makes it look like a remote edit.
  if (historyEditor && historyEditor !== editor && !historyEditor.isDestroyed && historyEditor.isEditable) {
    const visibleDoc = documentOf(historyEditor);
    // The saved update includes the host's full baseline, possibly newer remote edits.
    // Hydrate those as remote first so Undo owns only this AI operation.
    if (visibleDoc && visibleDoc !== doc) Y.applyUpdate(visibleDoc, Y.encodeStateAsUpdate(doc), 'proposal-baseline');
    applyPreparedSkillResult(historyEditor, update);
  }
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  Y.applyUpdate(doc, Uint8Array.from(atob(update), char => char.charCodeAt(0)), ySyncPluginKey);
  undo?.stopCapturing();
}

/** Resolve a saved suggestion only after its body is durably delivered. */
export async function waitForSkillResultDelivery(editor: Editor): Promise<void> {
  const doc = documentOf(editor);
  if (!doc) throw new Error("The collaborative document is unavailable.");
  await waitForNoteDelivery(doc);
}

/** Blank paragraphs and whitespace are empty; preserve other structure, media and artifacts. */
export function isGenuinelyEmptyNote(content: import("@tiptap/core").JSONContent): boolean {
  return content.type === "doc" && (content.content ?? []).every(paragraph =>
    paragraph.type === "paragraph" && (paragraph.content ?? []).every(node =>
      node.type === "hardBreak" || (node.type === "text" && typeof node.text === "string" &&
        node.text.trim().length === 0)));
}
