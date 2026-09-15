'use client';

import * as React from 'react';

type DockActions = {
  startRecording?: () => void;
  askAi?: () => void;
};
const actionsByNote = new Map<string, DockActions>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => listeners.forEach(listener => listener());

/** Publish the mounted dock's actions without creating another recording controller. */
export function useRegisterNoteDockActions(noteId: string | undefined, actions: DockActions) {
  React.useEffect(() => {
    if (!noteId) return;
    actionsByNote.set(noteId, actions);
    notify();
    return () => {
      if (actionsByNote.get(noteId) !== actions) return;
      actionsByNote.delete(noteId);
      notify();
    };
  }, [noteId, actions]);
}

export function useNoteDockActions(noteId: string) {
  return React.useSyncExternalStore(
    subscribe,
    () => actionsByNote.get(noteId),
    () => undefined
  );
}
