const STORAGE_KEY = "prismical:recentNotes";
const MAX_ENTRIES = 20;

type StoredEntry = { id: number; visitedAt: number };

function read(): StoredEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredEntry =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as StoredEntry).id === "number" &&
        typeof (entry as StoredEntry).visitedAt === "number",
    );
  } catch {
    return [];
  }
}

function write(entries: StoredEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage may be unavailable or full; ignore
  }
}

export function getRecentNoteIds(): number[] {
  return read()
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .map((entry) => entry.id);
}

export function recordNoteVisit(noteId: number): void {
  const now = Date.now();
  const filtered = read().filter((entry) => entry.id !== noteId);
  const next = [{ id: noteId, visitedAt: now }, ...filtered].slice(0, MAX_ENTRIES);
  write(next);
}

export function forgetNoteVisit(noteId: number): void {
  write(read().filter((entry) => entry.id !== noteId));
}
