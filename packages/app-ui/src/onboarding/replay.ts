// A usage threshold avoids guessing signup time from browser-local first access.
// Once retired, deleting notes or switching organizations must not bring the link back.
export function replayAvailable(userKey: string, noteCount: number): boolean {
  try {
    const key = `${userKey}:replay-retired`;
    if (noteCount >= 3) window.localStorage.setItem(key, '1');
    return window.localStorage.getItem(key) !== '1';
  } catch {
    return false;
  }
}
