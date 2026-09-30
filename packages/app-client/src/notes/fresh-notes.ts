// Notes created in this session that have not been opened yet. Creation navigates in-app, so an
// in-memory set is enough: the dock consumes the id once, when the new note first opens, to play
// its arrival glow.
const fresh = new Set<string>();

export function markNoteFresh(noteId: string): void {
  fresh.add(noteId);
}

/** One-shot: true the first time a freshly created note is opened. */
export function consumeFreshNote(noteId: string): boolean {
  return fresh.delete(noteId);
}
