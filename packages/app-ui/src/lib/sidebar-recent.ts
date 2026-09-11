/**
 * What the sidebar's folders and tags groups show: the newest few, plus wherever the user actually
 * is.
 *
 * The cap is what keeps a workspace with forty folders from making the sidebar unscrollable, now
 * that /folders and /tags hold the complete lists. Newest by creation is the rule, because
 * Favorites — its own group above, and available on both folders and tags — is how something older
 * gets pinned here; what is new is what you have not yet decided about.
 *
 * `keepIds` is what stops the cap from hiding the current context: the folder holding the open
 * note, the folder or tags the note list is filtered to. Those render as the active row, so
 * dropping them would leave the sidebar unable to say where you are. They are appended rather than
 * sorted in, so the newest-first run stays readable as itself.
 */
export function recentPlusCurrent<T extends { id: string; createdAt: string }>(
  items: readonly T[],
  limit: number,
  keepIds: readonly (string | null | undefined)[]
): T[] {
  // Newest-first before the slice: the sync lane hands rows back oldest-first, so slicing straight
  // off the collection would pin these groups to the oldest rows and never surface a new one.
  const recent = [...items]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
  const shown = new Set(recent.map(item => item.id));
  const keep = new Set(keepIds.filter((id): id is string => !!id));
  return [...recent, ...items.filter(item => keep.has(item.id) && !shown.has(item.id))];
}
