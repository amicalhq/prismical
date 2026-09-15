import type { Editor } from '@tiptap/core';
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

/** Stack changes can follow the editor transaction (notably the last undo/redo). */
export function subscribeEditorHistory(editor: Editor, update: () => void): () => void {
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  const events = [
    'stack-item-added',
    'stack-item-popped',
    'stack-item-updated',
    'stack-cleared',
  ] as const;
  for (const event of events) manager?.on(event, update);
  editor.on('transaction', update);
  editor.on('update', update);
  editor.on('destroy', update);
  return () => {
    for (const event of events) manager?.off(event, update);
    editor.off('transaction', update);
    editor.off('update', update);
    editor.off('destroy', update);
  };
}

/** Keep one synchronous AI body mutation separate from typing on both sides. */
export function withEditorHistoryBoundary<T>(
  editor: Editor,
  apply: () => T,
  historyEditor?: Editor | null
): T {
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  const source = editor.extensionManager.extensions.find(e => e.name === 'collaboration')?.options
    .document as Y.Doc | undefined;
  const target =
    historyEditor &&
    historyEditor !== editor &&
    !historyEditor.isDestroyed &&
    historyEditor.isEditable
      ? (historyEditor.extensionManager.extensions.find(e => e.name === 'collaboration')?.options
          .document as Y.Doc | undefined)
      : undefined;
  const targetManager =
    target && historyEditor ? yUndoPluginKey.getState(historyEditor.state)?.undoManager : undefined;
  if (source && target && source !== target)
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source), 'proposal-baseline');
  const forward = (update: Uint8Array, origin: unknown) => {
    if (target && origin === ySyncPluginKey) Y.applyUpdate(target, update, ySyncPluginKey);
  };
  manager?.stopCapturing();
  targetManager?.stopCapturing();
  source?.on('update', forward);
  try {
    return apply();
  } finally {
    source?.off('update', forward);
    manager?.stopCapturing();
    targetManager?.stopCapturing();
  }
}
