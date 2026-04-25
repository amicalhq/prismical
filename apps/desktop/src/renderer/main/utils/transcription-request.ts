// Cross-component signal for "open the transcription panel for note N".
//
// We use both a pending-request set AND a DOM event so the signal works
// regardless of whether the target note-wrapper is already mounted:
//   - Already mounted (same note re-trigger): the event listener handles it.
//   - Mounting fresh (cross-note navigation): the wrapper's mount effect
//     drains the pending set. This avoids races where an event fires before
//     React has committed the new wrapper and registered its listener.

const pending = new Set<number>();

export const TRANSCRIPTION_OPEN_EVENT = "prismical:open-transcription";

export function requestOpenTranscription(noteId: number): void {
  pending.add(noteId);
  window.dispatchEvent(
    new CustomEvent(TRANSCRIPTION_OPEN_EVENT, { detail: { noteId } }),
  );
}

export function consumeOpenTranscriptionRequest(noteId: number): boolean {
  if (!pending.has(noteId)) return false;
  pending.delete(noteId);
  return true;
}
