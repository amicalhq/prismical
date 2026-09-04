// Shared by the header and normal skill picker: an unsaved title is never overwritten by AI.
const drafts = new Map<string, Set<symbol>>();
export function setTitleDraftDirty(noteId: string, owner: symbol, dirty: boolean) {
  const owners = drafts.get(noteId) ?? new Set<symbol>();
  if (dirty) owners.add(owner);
  else owners.delete(owner);
  if (owners.size) drafts.set(noteId, owners);
  else drafts.delete(noteId);
}
export const hasDirtyTitleDraft = (noteId: string) => Boolean(drafts.get(noteId)?.size);
