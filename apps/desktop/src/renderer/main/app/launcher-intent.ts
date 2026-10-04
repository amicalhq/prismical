// Kept across the fresh-note resolver navigation, consumed by one native start.
let intent: string | undefined;
export const currentLauncherIntent = () => intent;
export const setLauncherIntent = (id: string | undefined) => {
  intent = id;
};
export const clearLauncherIntent = (id: string | undefined) => {
  if (intent === id) intent = undefined;
};
export async function validateLauncher(id: string | undefined, noteId: string | null) {
  if (!id) return true;
  const valid = intent === id && (await window.desktop.float.validateLauncherIntent(id, noteId));
  return valid && intent === id;
}
